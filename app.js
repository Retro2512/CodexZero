const number = new Intl.NumberFormat("en-US");
const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 2,
});

const dailyResults = document.querySelector("#daily-results");
const dailyResultsOutput = document.querySelector("#daily-results-output");
const eligible = document.querySelector("#eligible");
const eligibleOutput = document.querySelector("#eligible-output");
const promptRequests = document.querySelector("#prompt-requests");
const promptRequestsOutput = document.querySelector("#prompt-requests-output");
const beforeWeekValue = document.querySelector("#before-week-value");
const afterWeekValue = document.querySelector("#after-week-value");
const combinedSavedValue = document.querySelector("#combined-saved-value");
const combinedPercentValue = document.querySelector("#combined-percent-value");
const capacityValue = document.querySelector("#capacity-value");
const capacityPercentValue = document.querySelector("#capacity-percent-value");
const projectionModes = [...document.querySelectorAll('input[name="projection-mode"]')];
const projectionModeLabel = document.querySelector("#projection-mode-label");
const promptBeforePerRequest = 3552;
const maxSavePromptAfterPerRequest = 738;

function updateProjection() {
  const mode = projectionModes.find((input) => input.checked)?.value || "safe";
  const requestsPerDay = Number(promptRequests.value);
  const toolTokensPerDay = Number(dailyResults.value);
  const toolReduction = Number(eligible.value) / 100;
  const promptAfterPerRequest = mode === "max-save"
    ? maxSavePromptAfterPerRequest
    : promptBeforePerRequest;
  const beforeWeek = (requestsPerDay * promptBeforePerRequest * 7) + (toolTokensPerDay * 7);
  const afterWeek = (requestsPerDay * promptAfterPerRequest * 7) + (toolTokensPerDay * (1 - toolReduction) * 7);
  const savedWeek = beforeWeek - afterWeek;
  const reductionPercent = beforeWeek === 0 ? 0 : (savedWeek / beforeWeek) * 100;
  const capacity = afterWeek === 0 ? 0 : beforeWeek / afterWeek;
  const capacityIncrease = Math.max(0, (capacity - 1) * 100);

  promptRequestsOutput.value = number.format(requestsPerDay);
  dailyResultsOutput.value = number.format(toolTokensPerDay);
  eligibleOutput.value = `${eligible.value}%`;
  beforeWeekValue.textContent = compactNumber.format(Math.round(beforeWeek));
  afterWeekValue.textContent = compactNumber.format(Math.round(afterWeek));
  combinedSavedValue.textContent = compactNumber.format(Math.round(savedWeek));
  combinedPercentValue.textContent = `${Math.round(reductionPercent)}%`;
  capacityValue.textContent = `${capacity.toFixed(1)}×`;
  capacityPercentValue.textContent = `+${Math.round(capacityIncrease)}%`;
  projectionModeLabel.textContent = mode === "max-save"
    ? "Max Savings weekly estimate"
    : "Safe weekly estimate";
}

dailyResults.addEventListener("input", updateProjection);
eligible.addEventListener("input", updateProjection);
promptRequests.addEventListener("input", updateProjection);
for (const mode of projectionModes) mode.addEventListener("change", updateProjection);
updateProjection();

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
