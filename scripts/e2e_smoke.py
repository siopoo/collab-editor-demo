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

    expect(first.get_by_text("Connected", exact=True)).to_be_visible()
    expect(second.get_by_text("Connected", exact=True)).to_be_visible()
    expect(first.locator(".status-grid div").filter(has_text="Online Users").locator("dd")).to_have_text("2")

    first.get_by_role("button", name="Create the first block").click()
    expect(first.locator(".editable")).to_have_count(1)
    expect(second.locator(".editable")).to_have_count(1)

    first.locator(".editable").fill("Hello from browser A")
    expect(second.locator(".editable")).to_have_text("Hello from browser A", timeout=5_000)

    second.locator(".editable").fill("Edited by browser B")
    expect(first.locator(".editable")).to_have_text("Edited by browser B", timeout=5_000)
    expect(second.locator(".debug-panel").get_by_text("success", exact=False)).to_be_visible()

    second.get_by_role("button", name="Delete block", exact=False).click()
    expect(first.locator(".editable")).to_have_count(0)
    expect(second.locator(".editable")).to_have_count(0)

    first.screenshot(path=PROJECT_ROOT / "e2e-smoke.png", full_page=True)
    assert console_errors == [], console_errors
    context.close()
    browser.close()
