'use strict';

// Tests the actual panel component; no provider requests or hardware writes.
const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');
const webpack = require('webpack');
const puppeteer = require('puppeteer-core');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'tmp', 'agent-panel-qa');

async function main() {
  fs.mkdirSync(out, { recursive: true });
  await new Promise((resolve, reject) =>
    webpack(
      {
        mode: 'development',
        target: 'web',
        devtool: false,
        entry: path.join(
          root,
          'arduino-ide-extension/lib/test/browser/ai-agent-panel-fixture.js'
        ),
        output: { path: out, filename: 'panel.js', publicPath: '/' },
        resolve: { fallback: { path: false, fs: false } },
      },
      (error, stats) =>
        error || stats.hasErrors()
          ? reject(
              error || new Error(stats.toString({ all: false, errors: true }))
            )
          : resolve()
    )
  );
  const css = fs.readFileSync(
    path.join(root, 'arduino-ide-extension/src/browser/style/ai-agent.css'),
    'utf8'
  );
  const server = http.createServer((request, response) => {
    if (request.url === '/') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(
        '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Arduino Agent 面板验收</title><style>html,body{margin:0;height:100%;background:#eef2f5}#fixture{height:100vh;width:100%;--theia-editor-background:#fff;--theia-editor-foreground:#25282c;--theia-descriptionForeground:#8b8e93;--theia-focusBorder:#6c88d7;--theia-textLink-foreground:#4c6cad}body.dark #fixture{--theia-editor-background:#1e2024;--theia-editor-foreground:#e8e9eb;--theia-descriptionForeground:#94979d}</style><link rel="stylesheet" href="/panel.css"><div id="fixture" class="arduino-ai-agent-widget"></div><script src="/panel.js"></script></html>'
      );
    } else if (request.url === '/panel.css') {
      response.setHeader('content-type', 'text/css');
      response.end(css);
    } else {
      const file = path.join(out, path.basename(request.url.split('?')[0]));
      if (fs.existsSync(file) && file.endsWith('.js')) {
        response.setHeader('content-type', 'text/javascript');
        response.end(fs.readFileSync(file));
      } else {
        response.statusCode = 404;
        response.end();
      }
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath:
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--no-first-run'],
      userDataDir: path.join(out, 'browser-profile'),
    });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    const url = 'http://127.0.0.1:' + server.address().port;
    await page.setViewport({ width: 860, height: 910, deviceScaleFactor: 1 });
    await page.goto(url);
    await page.waitForSelector('.agent-code-block code');
    assert.deepStrictEqual(
      await page.evaluate(() => window.agentFixture.titles),
      { automatic: '编译按钮草图', renamed: '我的工程' }
    );
    assert.strictEqual(
      (await page.$$('.agent-thinking')).length,
      0,
      'finished tool-only turn shows a stale thinking placeholder'
    );
    assert.strictEqual(
      await page.$eval('.agent-reasoning', (node) => node.open),
      false
    );
    await page.click('.agent-reasoning summary');
    assert.strictEqual(
      await page.$eval('.agent-reasoning', (node) => node.open),
      true
    );
    assert(
      (
        await page.$eval('.agent-reasoning-text', (node) => node.textContent)
      ).includes('消抖')
    );
    assert(
      !(
        await page.$eval('.agent-message-content', (node) => node.textContent)
      ).includes('先检查按钮的消抖逻辑')
    );
    await page.screenshot({ path: path.join(out, 'agent-reasoning.png') });
    await page.click('.agent-reasoning summary');
    await page.click('[aria-label="显示对话侧栏"]');
    await page.screenshot({ path: path.join(out, 'agent-wide.png') });
    assert(await page.$('strong'), 'missing markdown');
    assert.strictEqual(
      await page.$eval('.agent-operation', (node) => node.open),
      false
    );
    await page.click('.agent-operation summary');
    assert.strictEqual(
      await page.$eval('.agent-operation', (node) => node.open),
      true
    );
    await page.click('[aria-label="收起对话侧栏"]');
    await page.setViewport({ width: 380, height: 780, deviceScaleFactor: 1 });
    await page.screenshot({ path: path.join(out, 'agent-narrow.png') });
    const assertLayout = async () => {
      const bounds = await page.evaluate(() => {
        const textarea = document
          .querySelector('.agent-composer textarea')
          .getBoundingClientRect();
        const send = document
          .querySelector('.agent-send')
          .getBoundingClientRect();
        return {
          scroll: document.querySelector('.agent-chat').scrollWidth,
          width: document.querySelector('.agent-chat').clientWidth,
          bottom: send.bottom,
          height: window.innerHeight,
          right: textarea.right,
          outer: window.innerWidth,
        };
      });
      assert(bounds.scroll <= bounds.width + 1, 'panel horizontal overflow');
      assert(
        bounds.bottom <= bounds.height && bounds.right <= bounds.outer,
        'composer clipped'
      );
    };
    await assertLayout();
    await page.focus('textarea[aria-label="给 AI 助手的消息"]');
    await page.keyboard.type('hello ');
    await page.keyboard.sendCharacter('你好，检查代码');
    await page.evaluate(() => window.agentFixture.setStatus('后台状态变化'));
    assert.strictEqual(
      await page.$eval('.agent-composer textarea', (node) => node.value),
      'hello 你好，检查代码'
    );
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.type('X');
    assert.strictEqual(
      await page.$eval('.agent-composer textarea', (node) => node.value),
      'hello 你好，检查代X码'
    );
    await page.keyboard.down('Shift');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Shift');
    assert(
      (
        await page.$eval('.agent-composer textarea', (node) => node.value)
      ).includes('\n')
    );
    await page.evaluate(() => {
      const input = document.querySelector('.agent-composer textarea');
      input.dispatchEvent(
        new CompositionEvent('compositionstart', { bubbles: true })
      );
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          keyCode: 229,
          isComposing: true,
          bubbles: true,
        })
      );
    });
    assert.strictEqual(
      await page.evaluate(() => window.agentFixture.calls.includes('send')),
      false,
      'IME Enter submitted'
    );
    await page.evaluate(() =>
      document
        .querySelector('.agent-composer textarea')
        .dispatchEvent(
          new CompositionEvent('compositionend', {
            bubbles: true,
            data: '你好',
          })
        )
    );
    await page.keyboard.press('Enter');
    assert.strictEqual(
      await page.evaluate(
        () => window.agentFixture.calls.filter((call) => call === 'send').length
      ),
      1
    );
    assert.strictEqual(
      await page.$eval('.agent-composer textarea', (node) => node.value),
      ''
    );
    await page.evaluate(() => window.agentFixture.setPending(true));
    await page.focus('.agent-composer textarea');
    await page.keyboard.type('next');
    assert.strictEqual(
      await page.$eval('.agent-composer textarea', (node) => node.value),
      'next',
      'draft blocked during response'
    );
    await page.click('[aria-label="停止当前请求"]');
    assert.strictEqual(
      await page.evaluate(() => window.agentFixture.state.pending),
      false
    );
    await page.click('.agent-model-choice');
    await page.select('[aria-label="选择思考等级"]', 'balanced');
    await page.select('[aria-label="选择模型"]', 'kimi-k2.6');
    assert.strictEqual(
      await page.evaluate(() => window.agentFixture.state.config.model),
      'kimi-k2.6'
    );
    await page.click('[aria-label="关闭菜单"]');
    await page.click('.agent-permission');
    await page.click('.agent-permission-options button:first-child');
    assert.strictEqual(
      await page.evaluate(() => window.agentFixture.state.config.approvalMode),
      'confirm'
    );
    await page.click('[aria-label="显示对话侧栏"]');
    await page.type('[aria-label="搜索历史对话"]', '温度');
    assert.strictEqual((await page.$$('.agent-history-open')).length, 1);
    await page.click('.agent-history-open');
    assert.strictEqual(
      await page.evaluate(() => window.agentFixture.state.activeId),
      'chat_serial'
    );
    await page.click('[aria-label="显示对话侧栏"]');
    await page.click('.agent-history-item.active [aria-label="重命名对话"]');
    await page.focus('[aria-label="对话名称"]');
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.sendCharacter('串口验收对话');
    await page.click('[aria-label="保存对话名称"]');
    assert.strictEqual(
      await page.evaluate(
        () =>
          window.agentFixture.state.conversations.find(
            (item) => item.id === 'chat_serial'
          ).title
      ),
      '串口验收对话'
    );
    await page.$eval('[aria-label="搜索历史对话"]', (node) => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value'
      ).set;
      setter.call(node, '');
      node.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('.agent-history-item.active [aria-label="删除对话"]');
    await page.click('.agent-delete-confirm button:first-of-type');
    assert.strictEqual(
      await page.evaluate(() => window.agentFixture.state.conversations.length),
      1
    );
    await page.click('[aria-label="收起对话侧栏"]');
    await page.click('[aria-label="新对话"]');
    await page.waitForSelector('.agent-welcome');
    await page.click('.agent-suggestions button');
    assert(
      (
        await page.$eval('.agent-composer textarea', (node) => node.value)
      ).includes('Arduino')
    );
    await page.click('[aria-label="连接设置"]');
    await page.waitForSelector('.agent-settings-drawer');
    await page.click('.agent-prompt-settings summary');
    await page.focus('[aria-label="Agent 内置提示词"]');
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.sendCharacter('仅按用户要求回答。');
    await page.keyboard.press('Enter');
    await page.keyboard.sendCharacter('保留中文输入和换行。');
    await page.evaluate(() =>
      window.agentFixture.setStatus('后台更新不会覆盖提示词编辑')
    );
    const customPrompt = await page.$eval(
      '[aria-label="Agent 内置提示词"]',
      (node) => node.value
    );
    assert.strictEqual(
      customPrompt,
      '仅按用户要求回答。\n保留中文输入和换行。'
    );
    await page.click('.agent-prompt-settings input[type="checkbox"]');
    await page.click('.agent-prompt-actions button:first-child');
    await page.waitForFunction(
      () =>
        window.agentFixture.state.config.systemPrompt ===
        '仅按用户要求回答。\n保留中文输入和换行。'
    );
    assert.strictEqual(
      await page.evaluate(
        () => window.agentFixture.state.config.includeIdeContext
      ),
      false
    );
    await page.click('.agent-prompt-actions button:nth-child(2)');
    assert(
      (
        await page.$eval(
          '[aria-label="Agent 内置提示词"]',
          (node) => node.value
        )
      ).includes('Arduino IDE 内置项目助手')
    );
    await page.click('.agent-prompt-actions button:first-child');
    await page.waitForFunction(
      () => window.agentFixture.state.config.systemPrompt === null
    );
    await page.screenshot({ path: path.join(out, 'agent-prompt-editor.png') });
    await assertLayout();
    await page.click('[aria-label="关闭连接设置"]');
    await assertLayout();
    await page.setViewport({ width: 300, height: 620 });
    await assertLayout();
    await page.evaluate(() => document.body.classList.add('dark'));
    await page.setViewport({ width: 560, height: 800 });
    await page.mouse.move(1, 1);
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        )
    );
    await page.screenshot({ path: path.join(out, 'agent-dark.png') });
    assert.deepStrictEqual(errors, [], 'browser runtime errors');
    console.log(
      '面板验收通过：思考展开/折叠、提示词编辑/保存/恢复、中文输入、Markdown、代码、停止、会话管理、模型/权限、300/380/860px 布局、深色主题。'
    );
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
