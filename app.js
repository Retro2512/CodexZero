const tabs = [...document.querySelectorAll('[role="tab"]')];
for (const tab of tabs) {
  tab.addEventListener("click", () => {
    for (const candidate of tabs) {
      const selected = candidate === tab;
      candidate.setAttribute("aria-selected", String(selected));
      document.querySelector(`#${candidate.getAttribute("aria-controls")}`).hidden = !selected;
    }
  });
}

for (const button of document.querySelectorAll(".copy-button")) {
  button.addEventListener("click", async () => {
    const panel = document.querySelector(`#${button.dataset.copyTarget}`);
    const command = panel.querySelector("code").textContent;
    await navigator.clipboard.writeText(command);
    button.textContent = "Copied";
    setTimeout(() => { button.textContent = "Copy"; }, 1600);
  });
}
