import { App } from '@modelcontextprotocol/ext-apps';

const app = new App({ name: 'EasyEDA Read-Only Project Review', version: '1.0.0' });
const project = document.getElementById('project') as HTMLElement;
const projectPill = document.getElementById('project-pill') as HTMLElement | null;
const report = document.getElementById('report') as HTMLElement;
const title = document.getElementById('result-title') as HTMLElement;
const copyBtn = document.getElementById('copy-btn') as HTMLButtonElement | null;
const buttons = ['bom', 'pcb', 'erc'].map(
  (name) => document.getElementById(name) as HTMLButtonElement,
);
let projectId: string | undefined;
let lastReportText = '';

function renderReport(payload: unknown): void {
  // Never use innerHTML for CAD fields, response text, or other untrusted tool output.
  lastReportText = JSON.stringify(payload, null, 2) ?? 'No result';
  report.textContent = lastReportText;
  if (copyBtn) {
    copyBtn.style.display = 'inline-block';
    copyBtn.textContent = 'Copy JSON';
    copyBtn.disabled = false;
  }
}

function setActiveButton(activeId?: string): void {
  for (const button of buttons) {
    const isSelected = button.id === activeId;
    button.setAttribute('aria-selected', String(isSelected));
    if (isSelected) {
      button.classList.add('active');
    } else {
      button.classList.remove('active');
    }
  }
}

function configureProject(value: unknown): void {
  if (typeof value !== 'string' || value.length > 128 || value.trim() !== value || !value) return;
  projectId = value;
  if (projectPill) {
    projectPill.textContent = value;
    projectPill.classList.add('active');
  } else {
    project.textContent = 'Project: ' + value;
  }
  for (const button of buttons) button.disabled = false;
}

app.ontoolinput = (input) => {
  configureProject(input.arguments?.projectId);
};

app.ontoolresult = (result) => {
  const content = result.structuredContent as { projectId?: unknown } | undefined;
  configureProject(content?.projectId);
  if (result.isError) renderReport({ error: 'MCP host reported an error starting the review.' });
  else renderReport({ status: 'Ready. Select a read-only report to retrieve current data.' });
};

const toolConfigs = {
  bom: { name: 'easyeda_bom_generate', additional: { format: 'json', groupBy: 'value' } },
  pcb: { name: 'easyeda_pcb_components', additional: { limit: 100, offset: 0 } },
  erc: { name: 'easyeda_erc_run', additional: {} },
} as const;

for (const button of buttons) {
  button.addEventListener('click', async () => {
    const config = toolConfigs[button.id as keyof typeof toolConfigs];
    if (!config || !projectId) return;
    setActiveButton(button.id);
    title.textContent = button.textContent ?? 'Report';
    report.textContent = 'Requesting read-only data from MCP host...';
    if (copyBtn) copyBtn.disabled = true;
    button.disabled = true;
    try {
      const response = await app.callServerTool({
        name: config.name,
        arguments: { projectId, ...config.additional },
      });
      if (response.isError)
        renderReport({ blocked: true, details: response.structuredContent ?? response.content });
      else renderReport(response.structuredContent ?? response.content);
    } catch (error) {
      renderReport({ unavailable: true, message: String(error) });
    } finally {
      button.disabled = false;
    }
  });
}

if (copyBtn) {
  copyBtn.addEventListener('click', async () => {
    if (!lastReportText) return;
    try {
      await navigator.clipboard.writeText(lastReportText);
      copyBtn.textContent = 'Copied!';
      setTimeout(() => {
        copyBtn.textContent = 'Copy JSON';
      }, 2000);
    } catch {
      copyBtn.textContent = 'Failed';
    }
  });
}

void app
  .connect()
  .catch((error) => renderReport({ hostUnavailable: true, message: String(error) }));
