import type { ApiRuntime } from './api-runtime.js';

export interface ProjectOperationDependencies {
  callFirst: ApiRuntime['callFirst'];
}

export interface ProjectOperations {
  list(params: Record<string, unknown>): Promise<unknown>;
  open(params: Record<string, unknown>): Promise<unknown>;
  close(params: Record<string, unknown>): Promise<unknown>;
  save(params: Record<string, unknown>): Promise<unknown>;
  export(params: Record<string, unknown>): Promise<unknown>;
}

type Data = Record<string, unknown>;
type Document = { documentId: string; type: 'schematic' | 'pcb' | 'panel'; tabId: string | null };
type Tab = { tabId?: unknown; title?: unknown; data?: unknown };
const MAX_PROJECTS = 250;
const MAX_TEAMS = 24;

function object(value: unknown): Data | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : undefined;
}

function id(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function tabsFrom(tree: unknown): Tab[] | undefined {
  const out: Tab[] = [];
  const visit = (node: unknown, depth: number): boolean => {
    const entry = object(node);
    if (!entry || depth > 6) return false;
    if (entry.tabs !== undefined && !Array.isArray(entry.tabs)) return false;
    if (entry.children !== undefined && !Array.isArray(entry.children)) return false;
    if (Array.isArray(entry.tabs)) {
      if (entry.tabs.some((item) => !object(item))) return false;
      out.push(...(entry.tabs as Tab[]));
    }
    return (
      !Array.isArray(entry.children) || entry.children.every((child) => visit(child, depth + 1))
    );
  };
  return visit(tree, 0) ? out : undefined;
}

function startPage(tab: Tab): boolean {
  // No user document: the editor's own Start Page (never use tab title as dirty proof).
  return tab.title === 'Start Page' && !id(object(tab.data)?.pid);
}

function documentTree(project: Data): Document[] {
  const documents: Document[] = [];
  const push = (item: unknown, type: Document['type']) => {
    const documentId = id(object(item)?.uuid);
    if (documentId && !documents.some((entry) => entry.documentId === documentId))
      documents.push({ documentId, type, tabId: null });
  };
  for (const node of Array.isArray(project.data) ? project.data : []) {
    const row = object(node);
    if (!row) continue;
    push(row.pcb, 'pcb');
    for (const page of Array.isArray(object(row.schematic)?.page)
      ? (object(row.schematic)?.page as unknown[])
      : [])
      push(page, 'schematic');
    // A panel can be closed by explicit discard, but native panel save remains BETA.
    if (row.panel) push(row.panel, 'panel');
  }
  return documents;
}

function withTabIds(documents: Document[], tabs: Tab[], projectId: string): Document[] {
  // EasyEDA 3.2.209 builds tab IDs by prefixing the native document UUID;
  // tab.data.creator identifies that exact document and tab.data.pid its project.
  // Never trust a title, a prefix alone, or a project PID alone for destructive close.
  return documents.map((doc) => {
    const matches = tabs.filter((tab) => {
      const tabId = id(tab.tabId);
      const data = object(tab.data);
      return (
        !!tabId &&
        tabId.startsWith(doc.documentId) &&
        id(data?.creator) === doc.documentId &&
        id(data?.pid) === projectId
      );
    });
    return { ...doc, tabId: matches.length === 1 ? (id(matches[0]?.tabId) ?? null) : null };
  });
}

export function createProjectOperations({
  callFirst,
}: ProjectOperationDependencies): ProjectOperations {
  const native = (path: string, ...args: unknown[]) => callFirst([path], ...args);
  async function current(): Promise<Data | undefined> {
    return object(await native('dmt_Project.getCurrentProjectInfo'));
  }

  async function readTabs(): Promise<Tab[] | undefined> {
    return tabsFrom(await native('dmt_EditorControl.getSplitScreenTree'));
  }

  async function discoverTeams(active: Data | undefined): Promise<Set<string> | undefined> {
    const teams = await native('dmt_Team.getAllTeamsInfo');
    const teamIds = new Set<string>();
    if (Array.isArray(teams))
      for (const team of teams) {
        const teamId = id(object(team)?.uuid);
        if (teamId) teamIds.add(teamId);
      }
    const activeTeam = id(active?.teamUuid);
    if (activeTeam) teamIds.add(activeTeam);
    return teamIds.size && teamIds.size <= MAX_TEAMS ? teamIds : undefined;
  }

  async function getScopedIds(teams: Set<string>): Promise<{ status: string; ids: Set<string> }> {
    const ids = new Set<string>();
    for (const teamId of teams) {
      const results = await native('dmt_Project.getAllProjectsUuid', teamId);
      if (!Array.isArray(results)) return { status: 'project_list_unavailable', ids };
      for (const value of results) {
        const projectId = id(value);
        if (!projectId) return { status: 'invalid_project_list', ids };
        ids.add(projectId);
      }
      if (ids.size > MAX_PROJECTS) return { status: 'project_list_limit', ids };
    }
    return { status: 'ok', ids };
  }

  async function projectSummaries(
    ids: Set<string>,
    activeId: string | undefined,
  ): Promise<
    Array<{ projectId: string; name: string; active: boolean; open: boolean | null }> | undefined
  > {
    const projects = [];
    for (const projectId of ids) {
      const brief = object(await native('dmt_Project.getProjectInfo', projectId));
      if (!brief || id(brief.uuid) !== projectId) return undefined;
      const isActive = projectId === activeId;
      projects.push({
        projectId,
        name: id(brief.friendlyName) ?? id(brief.name) ?? projectId,
        active: isActive,
        open: isActive ? true : null,
      });
    }
    return projects;
  }

  async function list(_params: Record<string, unknown>): Promise<unknown> {
    const active = await current();
    // Native no-argument getAllProjectsUuid returned [] in real 3.2.209 offline runtime.
    const teams = await discoverTeams(active);
    if (!teams) return { status: 'team_scope_unavailable', projects: [], complete: false };
    const scoped = await getScopedIds(teams);
    if (scoped.status !== 'ok') return { status: scoped.status, projects: [], complete: false };
    const projects = await projectSummaries(scoped.ids, id(active?.uuid));
    if (!projects) return { status: 'project_details_unavailable', projects: [], complete: false };
    return { status: 'ok', projects, complete: true, activeProjectId: id(active?.uuid) ?? null };
  }

  // waitForReady/getReadyState are BETA and require newer EasyEDA (4.1.79+).
  // On the supported 3.2.209 desktop, verify document data by repeated
  // read-only getCurrentProjectInfo rather than guessing an empty project.
  async function waitForDocumentTree(projectId: string): Promise<Data | undefined> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const value = await current();
      if (id(value?.uuid) === projectId && Array.isArray(value?.data) && value.data.length)
        return value;
      if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return undefined;
  }

  async function open(params: Record<string, unknown>): Promise<unknown> {
    const projectId = id(params.projectId);
    if (!projectId) return { success: false, status: 'invalid_project_id' };
    const before = await current();
    if (before && id(before.uuid) === projectId)
      return {
        success: true,
        status: 'already_active',
        projectId,
        documents: withTabIds(documentTree(before), (await readTabs()) ?? [], projectId),
      };
    if (params.confirmWrite !== true)
      return { success: false, status: 'confirm_write_required', projectId };
    const tabs = await readTabs();
    if (!tabs || tabs.some((tab) => !startPage(tab)))
      return { success: false, status: 'open_documents_may_be_dirty', projectId };
    const brief = object(await native('dmt_Project.getProjectInfo', projectId));
    if (!brief || id(brief.uuid) !== projectId)
      return { success: false, status: 'project_not_found', projectId };
    // Vendor openProject can silently discard another project's unsaved edits.
    // Only call it after proving no user document tabs are open.
    if ((await native('dmt_Project.openProject', projectId)) !== true)
      return { success: false, status: 'native_open_failed', projectId };
    const after = await waitForDocumentTree(projectId);
    if (!after) return { success: false, status: 'project_tree_not_ready', projectId };
    const updatedTabs = await readTabs();
    return {
      success: true,
      status: 'opened',
      projectId,
      documents: withTabIds(documentTree(after), updatedTabs ?? [], projectId),
    };
  }

  async function explicitlySaveOpenDocuments(
    documents: Array<Document & { tabId: string }>,
    projectId: string,
  ): Promise<string | undefined> {
    if (documents.some((doc) => doc.type === 'panel')) return 'panel_save_unsupported';
    for (const doc of documents) {
      if ((await native('dmt_EditorControl.activateDocument', doc.tabId)) !== true)
        return 'activation_failed';
      const focused = object(await native('dmt_SelectControl.getCurrentDocumentInfo'));
      if (id(focused?.uuid) !== doc.documentId || id(focused?.parentProjectUuid) !== projectId)
        return 'focused_document_mismatch';
      try {
        if ((await native(doc.type === 'pcb' ? 'pcb_Document.save' : 'sch_Document.save')) !== true)
          return 'save_failed';
      } catch {
        return 'save_failed';
      }
    }
    return undefined;
  }

  async function unchangedTabList(known: Set<string>): Promise<boolean> {
    const tabs = await readTabs();
    if (!tabs) return false;
    const observed = new Set(tabs.filter((tab) => !startPage(tab)).map((tab) => id(tab.tabId)));
    return observed.size === known.size && [...known].every((tab) => observed.has(tab));
  }

  // The native closeDocument Promise may resolve before the split-screen
  // state actually drops the closed tab. Re-read; NEVER repeat the close.
  async function waitForClosedTabs(closedTabs: string[]): Promise<boolean> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const currentTabs = await readTabs();
      if (currentTabs && currentTabs.every((tab) => !closedTabs.includes(id(tab.tabId) ?? '')))
        return true;
      if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return false;
  }

  async function closeVerifiedTabs(
    opened: Array<Document & { tabId: string }>,
    projectId: string,
  ): Promise<unknown> {
    const closedTabs: string[] = [];
    for (const doc of opened) {
      if ((await native('dmt_EditorControl.closeDocument', doc.tabId)) !== true)
        return { success: false, status: 'native_close_unverified', projectId, closedTabs };
      closedTabs.push(doc.tabId);
    }
    if (!(await waitForClosedTabs(closedTabs)))
      return { success: false, status: 'close_readback_unverified', projectId, closedTabs };
    return { success: true, status: 'closed', projectId, closedTabs };
  }

  async function verifyCloseBoundary(
    projectId: string,
    knownTabIds: Set<string>,
  ): Promise<string | undefined> {
    if (id((await current())?.uuid) !== projectId) return 'project_changed_during_close';
    if (!(await unchangedTabList(knownTabIds))) return 'tabs_changed_during_close';
    return undefined;
  }

  async function close(params: Record<string, unknown>): Promise<unknown> {
    const projectId = id(params.projectId);
    const mode = params.mode ?? 'refuse_if_dirty';
    if (!projectId || !['refuse_if_dirty', 'save', 'discard'].includes(String(mode)))
      return { success: false, status: 'invalid_close_request' };
    const active = await current();
    if (!active || id(active.uuid) !== projectId)
      return { success: false, status: 'active_project_mismatch', projectId };
    const tabs = await readTabs();
    if (!tabs) return { success: false, status: 'tab_state_unavailable', projectId };
    const docs = withTabIds(documentTree(active), tabs, projectId);
    const opened = docs.filter((doc): doc is Document & { tabId: string } => !!doc.tabId);
    const knownTabIds = new Set(opened.map((doc) => doc.tabId));
    if (tabs.some((tab) => !startPage(tab) && !knownTabIds.has(id(tab.tabId) ?? '')))
      return { success: false, status: 'unknown_document_tabs', projectId };
    if (!opened.length)
      return { success: true, status: 'already_closed', projectId, closedTabs: [] };
    // The official API has no dirty-state getter. Default never silently loses changes.
    if (mode === 'refuse_if_dirty')
      return {
        success: false,
        status: 'dirty_state_unavailable',
        projectId,
        openTabIds: [...knownTabIds],
      };
    if (params.confirmWrite !== true)
      return { success: false, status: 'confirm_write_required', projectId };
    if (mode === 'save') {
      const error = await explicitlySaveOpenDocuments(opened, projectId);
      if (error) return { success: false, status: error, projectId };
    }
    const unsafe = await verifyCloseBoundary(projectId, knownTabIds);
    if (unsafe) return { success: false, status: unsafe, projectId };
    return closeVerifiedTabs(opened, projectId);
  }

  async function save(_params: Record<string, unknown>): Promise<unknown> {
    return callFirst([
      'dmt_Workspace.saveAll',
      'dmt_Workspace.saveActiveDocument',
      'sch_Document.save',
      'pcb_Document.save',
      'pnl_Document.save',
    ]);
  }

  async function exportProject(params: Record<string, unknown>): Promise<unknown> {
    return callFirst(
      ['PCB_ManufactureData.getManufactureData', 'SCH_ManufactureData.getExportDocumentFile'],
      params,
    );
  }

  return { list, open, close, save, export: exportProject };
}
