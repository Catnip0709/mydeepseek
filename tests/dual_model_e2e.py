"""Browser regression tests. All API calls are mocked; no real key is used.

Run against a local HTTP server with Python Playwright installed:
  python tests/dual_model_e2e.py --base-url http://127.0.0.1:8765
Use --chrome to select an installed Chromium executable.
"""

import argparse
import json
import time
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright


FLASH = "deepseek-flash"
PRO = "deepseek-v4-pro"
MESSAGES = [
    {"id": "u1", "role": "user", "content": "Hello"},
    {"id": "a1", "role": "assistant", "content": "Hello back"},
]
SEED = {
    "dsApiKey": "fixture-not-a-real-api-key",
    "dsSelectedModel": PRO,
    "dsMemoryStrategy": "full",
    "dsTabs": json.dumps({
        "active": "tab1",
        "list": {"tab1": {"messages": MESSAGES, "title": "Fixture", "memoryLimit": "0"}},
    }),
}


class MockAPI:
    def __init__(self):
        self.requests = []
        self.responses = []
        self.pending = []
        self.hold_next = False

    def handle(self, route):
        if route.request.method == "OPTIONS":
            route.fulfill(status=204, headers={"Access-Control-Allow-Origin": "*"})
            return
        payload = route.request.post_data_json
        self.requests.append(payload)
        if self.hold_next:
            self.hold_next = False
            self.pending.append((route, payload))
        else:
            self.fulfill(route, payload)

    def fulfill(self, route, payload):
        response = self.responses.pop(0) if self.responses else {"content": "Mock reply."}
        finish = response.pop("finish_reason", "stop")
        if payload.get("stream"):
            body = "data: " + json.dumps({"choices": [{"delta": response, "finish_reason": finish}]})
            body += "\n\ndata: [DONE]\n\n"
            content_type = "text/event-stream"
        else:
            body = json.dumps({"choices": [{"message": response, "finish_reason": finish}]})
            content_type = "application/json"
        route.fulfill(status=200, content_type=content_type, body=body,
                      headers={"Access-Control-Allow-Origin": "*"})

    def reset(self, responses=None, hold=False):
        assert not self.pending
        self.requests.clear()
        self.responses = responses or []
        self.hold_next = hold

    def release(self):
        route, payload = self.pending.pop(0)
        self.fulfill(route, payload)


def wait_pending(page, api):
    deadline = time.monotonic() + 10
    while not api.pending and time.monotonic() < deadline:
        page.wait_for_timeout(50)
    assert api.pending, "Expected a pending mock request"


def start_job(page, expression):
    page.evaluate("""expression => {
        window.jobDone = false;
        window.jobError = null;
        window.jobResult = null;
        Promise.resolve().then(() => eval(expression)).then(result => {
            window.jobResult = result;
        }).catch(error => { window.jobError = String(error.stack || error); })
          .finally(() => { window.jobDone = true; });
    }""", expression)


def finish_job(page):
    page.wait_for_function("window.jobDone === true", timeout=15000)
    assert page.evaluate("window.jobError") is None, page.evaluate("window.jobError")


def load_app(page, url):
    page.goto(url, wait_until="networkidle")
    page.wait_for_function("typeof window.applyDeepThinkState === 'function'")
    page.evaluate("""async () => {
        const stateModule = await import('/modules/state.js?v=8');
        window.app = {state: stateModule.state, recovery: stateModule.storageRecoveryState};
        for (const name of ['llm', 'chat', 'groupchat', 'htmlmode', 'archive',
                            'summary', 'character', 'prompts', 'humanizer', 'storage']) {
            app[name] = await import('/modules/' + name + '.js?v=8');
        }
    }""")
    page.wait_for_function("document.querySelector('input[name=selectedModel]:checked') !== null")


def choose(page, model):
    if not page.locator("#settingsPanel").is_visible():
        if not page.evaluate("app.state.isSidebarOpen"):
            page.locator("#menuBtn").click()
        page.locator("#settingsBtn").click()
    page.locator("#modelPro" if model == PRO else "#modelFlash").check()
    assert page.evaluate("app.state.selectedModel") == model


def assert_models(api, expected, minimum=1):
    assert len(api.requests) >= minimum, api.requests
    assert all(body["model"] == expected for body in api.requests), [
        body["model"] for body in api.requests
    ]


def run(page, api, url, artifacts):
    load_app(page, url)
    for stored in [None, "", FLASH, PRO, "deepseek-v4-flash",
                   "deepseek-v4-flash-vision-exp", "deepseek-chat",
                   "deepseek-reasoner", "invalid"]:
        page.evaluate("""value => {
            if (value === null) localStorage.removeItem('dsSelectedModel');
            else localStorage.setItem('dsSelectedModel', value);
        }""", stored)
        load_app(page, url)
        expected = PRO if stored == PRO else FLASH
        assert page.evaluate("app.state.selectedModel") == expected
        assert page.evaluate("localStorage.getItem('dsSelectedModel')") == stored
    print("PASS: 9 stored-model compatibility cases, no startup rewrite", flush=True)

    page.evaluate("""() => {
        app.storage.flushPendingSaveImmediately();
        window.beforeTabs = localStorage.getItem('dsTabs');
        window.modelWrites = [];
        window.originalSetItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) {
            modelWrites.push(key);
            if (window.failModelSave && key === 'dsSelectedModel') {
                throw new DOMException('Fixture quota', 'QuotaExceededError');
            }
            return originalSetItem.call(this, key, value);
        };
    }""")
    choose(page, PRO)
    choose(page, FLASH)
    assert page.evaluate("modelWrites") == ["dsSelectedModel", "dsSelectedModel"]
    assert page.evaluate("localStorage.getItem('dsTabs') === beforeTabs")
    for guard in ["app.state.isReadOnlyPage", "app.recovery.dsTabsReadFailed", "window.failModelSave"]:
        page.evaluate(guard + " = true")
        page.locator("#modelPro").click()
        assert page.locator("#modelFlash").is_checked()
        assert page.evaluate("app.state.selectedModel") == FLASH
        assert page.evaluate("localStorage.getItem('dsSelectedModel')") == FLASH
        page.evaluate(guard + " = false")
    choose(page, PRO)
    load_app(page, url)
    assert page.evaluate("app.state.selectedModel") == PRO
    print("PASS: switching, reload, storage isolation, readonly and quota rollback", flush=True)

    for width, height in [(1280, 900), (390, 844), (320, 740)]:
        page.set_viewport_size({"width": width, "height": height})
        choose(page, PRO)
        for day in [False, True]:
            if page.locator("#settingsDayModeToggle").is_checked() != day:
                page.locator("label:has(#settingsDayModeToggle)").click()
            page.locator("label:has(#modelPro)").scroll_into_view_if_needed()
            page.wait_for_timeout(350)
            page.screenshot(path=str(artifacts / f"settings-{width}-{'day' if day else 'night'}.png"))
            assert page.locator("[role=radiogroup]").evaluate(
                "el => el.scrollWidth <= el.clientWidth")
            page.locator("#modelInfoToggle").click()
            assert page.locator("#modelInfoPanel").is_visible()
            assert page.locator("#modelInfoPanel .edit-container").evaluate(
                "el => el.scrollWidth <= el.clientWidth")
            page.screenshot(path=str(artifacts / f"prices-{width}-{'day' if day else 'night'}.png"))
            page.locator("#modelInfoPanel button").click()
    page.set_viewport_size({"width": 1280, "height": 900})
    print("PASS: desktop/mobile, day/night, prices and layout", flush=True)

    for model in [FLASH, PRO]:
        choose(page, model)
        for thinking in [False, True]:
            api.reset([{"content": "Answer.", "reasoning_content": "Reasoning."}])
            page.evaluate("value => { app.state.deepThink = value; }", thinking)
            page.locator("#settingsCloseBtn").click()
            start_job(page, "app.chat.fetchAndStreamResponse({tabId: 'tab1'})")
            finish_job(page)
            assert_models(api, model)
            assert api.requests[0]["thinking"]["type"] == ("enabled" if thinking else "disabled")
            assert api.requests[0].get("reasoning_effort") == ("max" if thinking else None)
            choose(page, model)
        api.reset([{"content": "{}"}] * 4)
        start_job(page, """(async () => {
            await app.llm.callLLM({messages: [{role:'user', content:'hello'}]});
            await app.llm.callLLMJSON({messages: [{role:'user', content:'hello'}]});
            await app.character.aiEnhanceCharacter('Test character');
            await app.prompts.requestOptimizedPrompt('Test prompt');
        })()""")
        finish_job(page)
        assert_models(api, model, 4)
    print("PASS: both models, thinking modes, LLM/JSON/character/prompt requests", flush=True)

    page.evaluate("""() => {
        app.state.characterData = [{id:'c1',name:'Test',replyLanguage:'zh-CN'}];
        Object.assign(app.state.tabData.list.tab1, {type:'single-character',characterId:'c1'});
    }""")
    for model in [FLASH, PRO]:
        choose(page, model)
        for thinking in [False, True]:
            page.evaluate("value => { app.state.deepThink = value; }", thinking)
            api.reset([{"content": "Character answer.", "reasoning_content": "Thought."}])
            start_job(page, "app.chat.fetchAndStreamResponse({tabId:'tab1'})")
            finish_job(page)
            assert_models(api, model)
            assert api.requests[0]["thinking"]["type"] == ("enabled" if thinking else "disabled")
    page.evaluate("delete app.state.tabData.list.tab1.type")
    print("PASS: character chat, both models and thinking modes", flush=True)

    api.reset()
    start_job(page, """(async () => {
        await app.llm.callLLM({model:'deepseek-flash', messages:[]});
        await app.llm.callLLM({model:'invalid', messages:[]});
        await app.llm.callLLMAgent({messages:[{role:'user',content:'fallback'}]});
    })()""")
    finish_job(page)
    assert [body["model"] for body in api.requests] == [FLASH, FLASH, PRO]
    assert api.requests[-1]["messages"][0]["content"] == "fallback"
    print("PASS: explicit override, invalid fallback, Agent without tools", flush=True)

    # Each multi-stage task is paused at its first HTTP request. Change the model
    # through the actual settings control, then verify all remaining requests.
    jobs = [
        ("HTML continuation", "app.llm.callLLMWithAutoContinue({messages: [{role:'user',content:'html'}]})",
         [{"content": "<html><body>Hello", "finish_reason": "length"},
          {"content": "</body></html>"}], 2),
        ("humanizer", "app.humanizer.generateHumanizedNormalReply({model: app.state.selectedModel, userText:'hello', payloadMsgs:[{role:'user',content:'hello'}]})",
         [{"content": "Draft reply."}, {"content": "Refined reply."}], 2),
        ("Agent loop", """app.llm.callLLMAgent({
            messages:[{role:'user',content:'hello'}],
            tools:[{type:'function',function:{name:'lookup',parameters:{type:'object',properties:{}}}}],
            toolExecutor: async () => 'result'
        })""",
         [{"tool_calls": [{"index": 0, "id": "call1", "type": "function",
                           "function": {"name": "lookup", "arguments": "{}"}}],
           "finish_reason": "tool_calls"}, {"content": "Final."}], 2),
        ("traditional group + translation", """app.groupchat.orchestrateGroupChat(
            'hello', [{id:'c1', name:'Test', replyLanguage:'en'}], [])""",
         [{"content": "[1]"}, {"content": "Reply."}, {"content": "Translation."}], 3),
        ("group follow-up", """app.groupchat.orchestrateGroupChat(
            'hello', [{id:'c1',name:'First'},{id:'c2',name:'Second'}], [])""",
         [{"content": "[1]"}, {"content": "Reply."}, {"content": "no"}], 3),
    ]
    for name, expression, responses, minimum in jobs:
        choose(page, PRO)
        api.reset(responses, hold=True)
        start_job(page, expression)
        wait_pending(page, api)
        choose(page, FLASH)
        api.release()
        finish_job(page)
        assert_models(api, PRO, minimum)
        api.reset()
        start_job(page, "app.llm.callLLM({messages:[{role:'user',content:'next'}]})")
        finish_job(page)
        assert_models(api, FLASH)
        print("PASS: " + name + " snapshot and subsequent new model", flush=True)

    choose(page, PRO)
    page.locator("#settingsCloseBtn").click()
    page.locator("#input").fill("Summarize this text")
    page.evaluate("""() => {
        app.state.pendingTextAttachment = {
            fileName:'fixture.txt', mode:'summary', originalText:'Story '.repeat(5000),
            originalCharCount:30000, runtimeStatus:'ready'
        };
    }""")
    api.reset([{"content": "Compressed text."}, {"content": "Final answer."}], hold=True)
    start_job(page, "app.chat.sendMessage()")
    wait_pending(page, api)
    choose(page, FLASH)
    api.release()
    finish_job(page)
    assert_models(api, PRO, 2)
    print("PASS: TXT compression and main reply keep entry model", flush=True)

    choose(page, PRO)
    page.evaluate("""() => {
        app.state.tabData.list.tab1.messages = Array.from({length: 25}, (_, i) => ({
            id:'html' + i, role:i % 2 ? 'assistant' : 'user', content:'Story'
        }));
        delete app.state.tabData.list.tab1.summary;
    }""")
    api.reset([{"content": "Story summary."}, {"content": "<html><body>Generated</body></html>"}],
              hold=True)
    start_job(page, "app.htmlmode.sendHtmlGenerationMessage({tabId:'tab1', userText:'html'})")
    wait_pending(page, api)
    choose(page, FLASH)
    api.release()
    finish_job(page)
    assert_models(api, PRO, 2)
    assert page.evaluate("!!app.state.tabData.list.tab1.messages.at(-1).htmlGeneration")
    print("PASS: HTML temporary summary and generation snapshot", flush=True)

    choose(page, PRO)
    page.evaluate("""() => {
        app.state.tabData.list.tab2 = {
            title:'Concurrent', messages:[{id:'second',role:'user',content:'second tab'}]
        };
    }""")
    api.reset(hold=True)
    start_job(page, "app.chat.fetchAndStreamResponse({tabId:'tab1'})")
    wait_pending(page, api)
    choose(page, FLASH)
    page.evaluate("app.chat.fetchAndStreamResponse({tabId:'tab2'})")
    api.release()
    finish_job(page)
    assert [body["model"] for body in api.requests] == [PRO, FLASH]
    assert page.evaluate("app.state.tabData.list.tab2.messages.at(-1).role") == "assistant"
    print("PASS: concurrent chats retain independent model snapshots", flush=True)

    choose(page, PRO)
    page.evaluate("""() => {
        app.state.tabData.list.tab1.messages = Array.from({length: 200}, (_, i) => ({
            id: 'archive' + i, role: i % 2 ? 'assistant' : 'user', content: 'Story '.repeat(100)
        }));
    }""")
    api.reset([{"content": '{"overview":{"summary":"Story"},"relationships":[],"timeline":[]}'},
               {"content": '{"foreshadows":[]}'}], hold=True)
    start_job(page, "app.archive.generateStoryArchive('tab1', {silent:true})")
    wait_pending(page, api)
    choose(page, FLASH)
    api.release()
    finish_job(page)
    assert_models(api, PRO, 2)
    assert page.evaluate("window.jobResult !== null")
    assert page.evaluate("!!app.state.tabData.list.tab1.storyArchive")
    print("PASS: archive core/extras snapshot and persistence", flush=True)

    api.reset()
    page.evaluate("""() => {
        app.state.memoryStrategy = 'window';
        delete app.state.tabData.list.tab1.summary;
        app.state.tabData.list.tab1.summaryCoversUpTo = 0;
    }""")
    start_job(page, "app.summary.checkAndGenerateSummary('tab1')")
    finish_job(page)
    assert_models(api, FLASH)
    assert page.evaluate("!!app.state.tabData.list.tab1.summary")
    print("PASS: independent background summary uses current model", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8765")
    parser.add_argument("--chrome")
    parser.add_argument("--artifacts", default=".tmp-dual-model/screenshots")
    args = parser.parse_args()
    artifacts = Path(args.artifacts)
    artifacts.mkdir(parents=True, exist_ok=True)
    api = MockAPI()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=args.chrome)
        context = browser.new_context(ignore_https_errors=True, viewport={"width": 1280, "height": 900})
        context.add_init_script("""if (!localStorage.getItem('dualModelFixture')) {
            const seed = """ + json.dumps(SEED) + """;
            for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value);
            localStorage.setItem('dualModelFixture', 'true');
        }""")
        allowed = {urlparse(args.base_url).netloc, "cdn.tailwindcss.com",
                   "cdn.jsdelivr.net", "raw.githubusercontent.com"}

        def route_request(route):
            if urlparse(route.request.url).netloc == "api.deepseek.com":
                api.handle(route)
            elif urlparse(route.request.url).netloc in allowed:
                route.continue_()
            else:
                route.fulfill(status=200, body="{}", content_type="application/json")

        context.route("**/*", route_request)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        try:
            run(page, api, args.base_url, artifacts)
            assert not errors, errors
            print("PASS: no uncaught browser errors; no live API requests", flush=True)
        finally:
            context.close()
            browser.close()


if __name__ == "__main__":
    main()
