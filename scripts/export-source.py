"""Export reviewed source files; never copy the working directory wholesale."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tempfile
from urllib.parse import quote
import zipfile

ROOT_FILES = {
    '.eslintrc.js', '.gitignore', '.prettierignore', '.prettierrc.json',
    'BUILDING.md', 'LICENSE.txt', 'README.md', 'SECURITY.md',
    'lerna.json', 'package.json', 'yarn.lock',
}
SOURCE_ROOTS = {'arduino-ide-extension', 'electron-app', 'docs', 'i18n', 'scripts', 'static', '.vscode'}
PRIVATE_PARTS = {
    '.git', 'node_modules', '.browser_modules', 'dist', 'lib', 'tmp', 'agent-data',
    'src-gen', '.cache', 'traces', 'downloads', 'plugins', 'packages', 'staging',
    '.arduinoIDE', '.arduinoIDE-Agent', 'release-source', '__pycache__',
}
PRIVATE_NAMES = {'ai-agent.json', 'ai-agent-history.json', 'builder-debug.yml', 'inventory.yaml'}
BUILD_SUFFIXES = {'.exe', '.dll', '.node', '.pdb', '.msi', '.dmg', '.pfx', '.p12', '.pem', '.key', '.log', '.pyc'}
INVALID_ARCHIVE_FIXTURE = 'electron-app/test/test-resources/not-a-zip.dmg'
PATTERNS = {
    'private-key': re.compile(rb'-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----'),
    'credential-token': re.compile(rb'\b(?:sk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})\b'),
    'literal-auth': re.compile(rb'''(?i)(?:api[_-]?key|access[_-]?token|password|authorization|cookie)\s*[=:]\s*["'](?:Bearer )?([A-Za-z0-9_./+=-]{20,})["']'''),
    'url-credential': re.compile(rb'https?://[^\s/@:]+:[^\s/@]+@'),
}
SAFE_EXAMPLES = {b'your-api-key', b'your_api_key', b'YOUR_API_KEY', b'YOUR_TOKEN', b'placeholder'}


def public_path(name):
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts or '\\' in name:
        return False
    if any(part in PRIVATE_PARTS or part.startswith('.agent-profile') for part in path.parts):
        return False
    if path.name in PRIVATE_NAMES or path.name.startswith(('ai-agent.json.', 'ai-agent-history.json.', '.env')):
        return False
    if path.suffix.lower() in BUILD_SUFFIXES and name != INVALID_ARCHIVE_FIXTURE:
        return False
    if path.suffix.lower() == '.zip' and not name.startswith('electron-app/test/test-resources/'):
        return False
    if name.startswith('arduino-ide-extension/src/node/resources/') or name.startswith('arduino-ide-extension/Examples/'):
        return False
    return name in ROOT_FILES or path.parts[0] in SOURCE_ROOTS or name == '.github/workflows/agent-check.yml'


def scan_bytes(name, data, known_secrets=(), private_markers=(), depth=0):
    findings = []
    for label, pattern in PATTERNS.items():
        for match in pattern.finditer(data):
            if label == 'literal-auth' and match.group(1) in SAFE_EXAMPLES:
                continue
            findings.append({'file': name, 'rule': label, 'line': data.count(b'\n', 0, match.start()) + 1})
    for label, markers in [('known-secret', known_secrets), ('local-identity', private_markers)]:
        if any(marker and marker in data for marker in markers):
            findings.append({'file': name, 'rule': label})
    if data.startswith(b'PK\x03\x04'):
        if depth >= 3:
            findings.append({'file': name, 'rule': 'nested-archive-limit'})
        else:
            try:
                with zipfile.ZipFile(io.BytesIO(data)) as archive:
                    if sum(item.file_size for item in archive.infolist()) > 64 * 1024 * 1024:
                        findings.append({'file': name, 'rule': 'archive-size-limit'})
                    else:
                        for item in archive.infolist():
                            if item.is_dir():
                                continue
                            inner = f'{name}!{item.filename}'
                            inner_path = PurePosixPath(item.filename)
                            if inner_path.name in PRIVATE_NAMES or inner_path.name.startswith('.env') or '.git' in inner_path.parts:
                                findings.append({'file': inner, 'rule': 'private-data-file'})
                            if item.flag_bits & 1:
                                findings.append({'file': inner, 'rule': 'encrypted-archive'})
                            else:
                                findings.extend(scan_bytes(inner, archive.read(item), known_secrets, private_markers, depth + 1))
            except (zipfile.BadZipFile, RuntimeError):
                findings.append({'file': name, 'rule': 'unreadable-archive'})
    return findings


def local_markers(root):
    markers = set()
    for text in [str(root.resolve()), root.resolve().as_posix()]:
        for encoding in ['utf8', 'utf-16-le']:
            markers.add(text.encode(encoding))
    home = Path.home()
    if home.name:
        variants = [str(home), home.as_posix(), home.as_uri()]
        for text in variants:
            for encoding in ['utf8', 'utf-16-le']:
                markers.add(text.encode(encoding))
                markers.add(text.replace('\\', '\\\\').encode(encoding))
    return tuple(markers)


def tracked_sources(root):
    raw = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root)
    names = sorted(set(filter(None, raw.decode('utf8').split('\0'))))
    return [name for name in names if public_path(name)]


def collect(root, names, known_secrets=()):
    contents = {}
    findings = []
    markers = local_markers(root)
    base = root.resolve()
    for name in names:
        file = root / name
        if file.is_symlink() or not file.resolve().is_relative_to(base):
            findings.append({'file': name, 'rule': 'outside-source-root'})
            continue
        if not file.is_file():
            findings.append({'file': name, 'rule': 'missing-source-file'})
            continue
        data = file.read_bytes()
        contents[name] = data
        findings.extend(scan_bytes(name, data, known_secrets, markers))
    return contents, findings


def write_archive(contents, output, source_commit):
    manifest = {'formatVersion': 1, 'sourceCommit': source_commit, 'files': [
        {'path': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
        for name, data in sorted(contents.items())
    ]}
    archive_contents = {**contents, 'SOURCE-MANIFEST.json': (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf8')}
    output.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix='source-', suffix='.zip.tmp', dir=output.parent)
    os.close(handle)
    try:
        with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, data in sorted(archive_contents.items()):
                item = zipfile.ZipInfo('arduino-ide-agent-source/' + name, (1980, 1, 1, 0, 0, 0))
                item.external_attr = 0o100644 << 16
                item.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(item, data)
        with zipfile.ZipFile(temporary) as archive:
            if archive.testzip() is not None:
                raise ValueError('ZIP 完整性校验失败')
        os.replace(temporary, output)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return len(archive_contents)


def verify_archive(file, known_secrets=(), private_markers=()):
    findings = []
    with zipfile.ZipFile(file) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            findings.append({'rule': 'duplicate-archive-entry'})
        if archive.testzip() is not None:
            findings.append({'rule': 'zip-integrity'})
        manifest_name = 'arduino-ide-agent-source/SOURCE-MANIFEST.json'
        manifest = json.loads(archive.read(manifest_name))
        expected = {entry['path']: entry for entry in manifest['files']}
        actual = set()
        for name in names:
            if not name.startswith('arduino-ide-agent-source/'):
                findings.append({'file': name, 'rule': 'unexpected-archive-root'})
            relative = name.removeprefix('arduino-ide-agent-source/')
            data = archive.read(name)
            if relative != 'SOURCE-MANIFEST.json':
                actual.add(relative)
                entry = expected.get(relative)
                if not public_path(relative):
                    findings.append({'file': relative, 'rule': 'non-source-path'})
                if not entry or entry['sha256'] != hashlib.sha256(data).hexdigest() or entry['bytes'] != len(data):
                    findings.append({'file': relative, 'rule': 'manifest-mismatch'})
            findings.extend(scan_bytes(relative, data, known_secrets, private_markers))
        if actual != set(expected):
            findings.append({'rule': 'manifest-file-set'})
    return findings


def main():
    parser = argparse.ArgumentParser(description='仅打包已跟踪的源码，并拒绝凭据、私有数据和本机路径。')
    parser.add_argument('--check', action='store_true', help='只检查，不生成 ZIP')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--zip', type=Path, help='复核已生成的源码包与清单')
    parser.add_argument('--known-secrets-stdin', action='store_true', help='从标准输入读取待比对的字符串数组，不输出具体值')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    secrets = []
    if args.known_secrets_stdin:
        values = json.load(sys.stdin)
        if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
            raise ValueError('标准输入必须是字符串数组')
        secrets = [variant for value in values if value for variant in (
            value.encode('utf8'), value.encode('utf-16-le'), quote(value, safe='').encode('ascii'),
        )]
    if args.zip:
        findings = verify_archive(args.zip, secrets, local_markers(root))
        result = {'mode': 'verify', 'findings': findings, 'passed': not findings}
    else:
        files = tracked_sources(root)
        contents, findings = collect(root, files, secrets)
        result = {'mode': 'check' if args.check else 'export', 'sourceFiles': len(files), 'findings': findings, 'passed': not findings}
        if not findings and not args.check:
            changed = subprocess.check_output(['git', 'diff', '--name-only', 'HEAD', '-z'], cwd=root).decode().split('\0')
            untracked = subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard', '-z'], cwd=root).decode().split('\0')
            if any(name and public_path(name) for name in changed + untracked):
                print(json.dumps({'passed': False, 'message': '请先提交源码变更，再导出与提交一致的源码包。'}, ensure_ascii=False))
                return 1
            commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root).decode().strip()
            output = args.output or root / 'release-source' / f'arduino-ide-agent-source-{commit[:8]}.zip'
            result['archiveEntries'] = write_archive(contents, output, commit)
            result['sha256'] = hashlib.sha256(output.read_bytes()).hexdigest().upper()
            result['archive'] = output.name
    print(json.dumps(result, ensure_ascii=False))
    return 1 if result['findings'] else 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.SubprocessError, zipfile.BadZipFile, KeyError) as error:
        # Do not echo exception text: it may contain the user's path or values.
        print(json.dumps({'passed': False, 'error': type(error).__name__, 'message': '源码导出失败，请检查 Git、文件权限与参数。'}, ensure_ascii=False))
        raise SystemExit(1)
