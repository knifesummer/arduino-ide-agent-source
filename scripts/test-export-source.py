import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('source_export', Path(__file__).with_name('export-source.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SourceExportTests(unittest.TestCase):
    def test_excludes_private_data_and_builds(self):
        for name in ['.git/config', 'tmp/conversation.txt', 'agent-data/home/settings.json', 'electron-app/dist/app.exe',
                     '.agent-profile-test/config.json', 'docs/.env', 'scripts/api.key', 'ai-agent.json',
                     'electron-app/launcher/Arduino IDE Agent.exe', '../outside.ts']:
            with self.subTest(name=name):
                self.assertFalse(module.public_path(name))

    def test_includes_buildable_sources_and_licenses(self):
        for name in ['LICENSE.txt', 'package.json', 'yarn.lock', 'README.md',
                     'arduino-ide-extension/src/node/ai-agent-provider.ts', 'electron-app/launcher/main.go',
                     'electron-app/resources/icon.ico', 'scripts/export-source.py', '.github/workflows/agent-check.yml',
                     'electron-app/test/test-resources/not-a-zip.dmg']:
            self.assertTrue(module.public_path(name))

    def test_preserves_safe_examples_and_flags_real_credentials(self):
        value = ('sk-proj-' + 'a' * 28).encode()
        self.assertTrue(module.scan_bytes('src/test.ts', value))
        self.assertTrue(module.scan_bytes('src/test.ts', b'apiKey="' + b'a' * 28 + b'"'))
        self.assertEqual(module.scan_bytes('src/test.ts', b'apiKey="YOUR_API_KEY"'), [])

    def test_checks_binary_identity_and_exact_secrets(self):
        marker = 'C:/Users/private-user'.encode('utf-16-le')
        self.assertTrue(module.scan_bytes('resources/icon.bin', b'\0' + marker, (), (marker,)))
        self.assertTrue(module.scan_bytes('src/test.ts', b'not-a-key-shaped-value', (b'not-a-key-shaped-value',)))

    def test_scans_nested_fixtures(self):
        blob = io.BytesIO()
        with zipfile.ZipFile(blob, 'w') as archive:
            archive.writestr('ai-agent-history.json', '{}')
        self.assertTrue(module.scan_bytes('fixture.zip', blob.getvalue()))

    def test_manifest_round_trip_and_tamper_detection(self):
        # Each TemporaryDirectory owns its files; no existing project/profile is touched.
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1] / 'tmp') as directory:
            file = Path(directory) / 'source.zip'
            contents = {'README.md': b'Example', 'LICENSE.txt': b'License', 'package.json': b'{}'}
            self.assertEqual(module.write_archive(contents, file, 'a' * 40), 4)
            self.assertEqual(module.verify_archive(file), [])
            with zipfile.ZipFile(file, 'a') as archive:
                archive.writestr('arduino-ide-agent-source/tmp/history.json', '{}')
            self.assertTrue(module.verify_archive(file))

    def test_rejects_a_file_outside_the_archive_root(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1] / 'tmp') as directory:
            file = Path(directory) / 'source.zip'
            module.write_archive({'README.md': b'Example'}, file, 'a' * 40)
            with zipfile.ZipFile(file, 'a') as archive:
                archive.writestr('README.md', b'Example')
            self.assertIn('unexpected-archive-root', [finding['rule'] for finding in module.verify_archive(file)])


if __name__ == '__main__':
    unittest.main()
