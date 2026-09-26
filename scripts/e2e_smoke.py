from pathlib import Path

from playwright.sync_api import expect, sync_playwright


PROJECT_ROOT = Path(__file__).resolve().parents[1]


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    first = context.new_page()
    second = context.new_page()
    console_errors: list[str] = []
    first.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
    second.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)

    first.goto("http://127.0.0.1:5173/?doc=e2e-smoke")
    first.wait_for_load_state("networkidle")
    second.goto("http://127.0.0.1:5173/?doc=e2e-smoke")
    second.wait_for_load_state("networkidle")

    expect(first).to_have_title("协同编辑器 Demo")
    expect(first.get_by_role("heading", name="协同编辑器", exact=True)).to_be_visible()
    expect(first.get_by_text("已连接", exact=True)).to_be_visible()
    expect(second.get_by_text("已连接", exact=True)).to_be_visible()
    expect(first.locator(".status-grid div").filter(has_text="在线人数").locator("dd")).to_have_text("2")
    expect(first.get_by_text("当前文档还没有内容", exact=True)).to_be_visible()
    expect(first.get_by_text("最近一次 ACK", exact=True)).to_be_visible()
    expect(first.get_by_text("待确认操作", exact=True)).to_be_visible()
    expect(first.get_by_text("最近一次冲突", exact=True)).to_be_visible()

    first.get_by_role("button", name="新建第一个文本块").click()
    expect(first.locator(".editable")).to_have_count(1)
    expect(second.locator(".editable")).to_have_count(1)
    expect(first.locator(".editable")).to_have_attribute("data-placeholder", "请输入内容…")

    first.locator(".editable").fill("Hello from browser A")
    expect(second.locator(".editable")).to_have_text("Hello from browser A", timeout=5_000)

    second.locator(".editable").fill("Edited by browser B")
    expect(first.locator(".editable")).to_have_text("Edited by browser B", timeout=5_000)
    expect(second.locator(".debug-panel").get_by_text("成功", exact=False)).to_be_visible()

    second.get_by_role("button", name="删除文本块", exact=False).click()
    expect(first.locator(".editable")).to_have_count(0)
    expect(second.locator(".editable")).to_have_count(0)

    first.screenshot(path=PROJECT_ROOT / "e2e-smoke.png", full_page=True)
    assert console_errors == [], console_errors
    context.close()
    browser.close()
