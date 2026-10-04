import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { apiForTarget } from '../../app/api';
import { parseOwnedResourceId, targetForResource, type ApiTarget } from '../../app/apiTargets';
import type { FileNode, Tab } from '../../app/types';
import { usePolling } from '../../app/usePolling';

type WorkspaceFile = { path: string; type: 'file' | 'directory' };

type UseWorkspaceFilesOptions = {
  tabs?: Tab[];
  selectedAgentId: string;
  targets: ApiTarget[];
  setTabs: Dispatch<SetStateAction<Tab[]>>;
  setActiveTabId: Dispatch<SetStateAction<string>>;
  pollingEnabled?: boolean;
};

export function useWorkspaceFiles({ tabs, selectedAgentId, targets, setTabs, setActiveTabId, pollingEnabled = true }: UseWorkspaceFilesOptions) {
  const pendingLoads = useRef(new Set<string>());
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const [workspaceFiles, setWorkspaceFiles] = useState<FileNode[]>([]);
  const workspaceListingRef = useRef<WorkspaceFile[]>([]);
  const ownerFor = useCallback((agentId: string) => targetForResource(targets, agentId), [targets]);
  useEffect(() => {
    workspaceListingRef.current = [];
    setWorkspaceFiles([]);
  }, [selectedAgentId]);

  const refreshWorkspaceFiles = useCallback(async (agentId: string, shouldCommit: () => boolean = () => true) => {
    const owner = ownerFor(agentId);
    const { files } = await apiForTarget<{ files: WorkspaceFile[] }>(owner.target, `/api/workspace/files?agentId=${encodeURIComponent(owner.resourceId)}&scope=agent`);
    if (!shouldCommit() || sameWorkspaceListing(workspaceListingRef.current, files)) return;
    workspaceListingRef.current = files;
    setWorkspaceFiles(fileTreeFromPaths(files));
  }, [ownerFor]);

  usePolling(async (isCancelled) => {
    if (!selectedAgentId) {
      if (!isCancelled()) setWorkspaceFiles([]);
      return;
    }
    try { await refreshWorkspaceFiles(selectedAgentId, () => !isCancelled()); } catch { /* Keep the last known tree. */ }
  }, 2_000, pollingEnabled, selectedAgentId);

  const openFile = useCallback(async (file: FileNode) => {
    if (file.type !== 'file' || !selectedAgentId) return;
    const agentId = selectedAgentId;
    const owner = ownerFor(agentId);
    const tabId = `${agentId}:${file.path}`;
    setActiveTabId(tabId);
    const existing = tabsRef.current?.find(tab => tab.id === tabId);
    if (existing?.fileLoaded || pendingLoads.current.has(tabId)) return;
    pendingLoads.current.add(tabId);
    const loadId = crypto.randomUUID();
    const loadingTab: Tab = {
      id: tabId, path: file.path, label: file.name, kind: 'file', content: '', fileLoadId: loadId,
      fileLoaded: false, fileLoading: true, workspaceAgentId: agentId, targetId: owner.target.id,
    };
    setTabs((all) => all.some(tab => tab.id === tabId)
      ? all.map(tab => tab.id === tabId ? { ...tab, fileLoadId: loadId, fileLoading: true, fileError: undefined } : tab)
      : [...all, loadingTab]);
    try {
      const { content } = await apiForTarget<{ content: string }>(owner.target, `/api/workspace/file?agentId=${encodeURIComponent(owner.resourceId)}&scope=agent&path=${encodeURIComponent(file.path)}`);
      setTabs((all) => all.map((tab) => tab.id === tabId && tab.fileLoadId === loadId && tab.content === (existing?.content ?? '') ? { ...tab, content, fileLoaded: true, fileLoading: false, fileError: undefined, savedContent: content } : tab));
    } catch (error) {
      setTabs((all) => all.map((tab) => tab.id === tabId && tab.fileLoadId === loadId && tab.content === (existing?.content ?? '') ? { ...tab, fileLoading: false, fileError: `Could not read ${file.path}: ${(error as Error).message}` } : tab));
    } finally {
      pendingLoads.current.delete(tabId);
    }
  }, [ownerFor, selectedAgentId, setActiveTabId, setTabs]);

  const saveFile = useCallback(async (tab: Tab, content: string) => {
    if (!tab.workspaceAgentId || !tab.path) throw new Error('No agent workspace file is selected.');
    if (!tab.fileLoaded || tab.fileLoading || tab.fileError) throw new Error('Workspace file is not loaded.');
    const parsed = parseOwnedResourceId(tab.workspaceAgentId);
    if (!tab.targetId || tab.targetId !== parsed.targetId) throw new Error('Workspace file owner is missing or inconsistent.');
    const target = targets.find((item) => item.id === tab.targetId && item.enabled);
    if (!target) throw new Error(`Workspace file target ${tab.targetId} is unavailable.`);
    const owner = { target, resourceId: parsed.resourceId };
    const result = await apiForTarget<{ content: string }>(owner.target, '/api/workspace/file', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: owner.resourceId, scope: 'agent', path: tab.path, content }),
    });
    setTabs((all) => all.map((item) => item.id === tab.id ? { ...item, content: item.content === tab.content ? result.content : item.content, savedContent: result.content } : item));
  }, [targets, setTabs]);

  return { workspaceFiles, refreshWorkspaceFiles, openFile, saveFile };
}

function sameWorkspaceListing(current: WorkspaceFile[], next: WorkspaceFile[]) {
  return current.length === next.length && current.every((file, index) => file.path === next[index]?.path && file.type === next[index]?.type);
}

function fileTreeFromPaths(files: WorkspaceFile[]): FileNode[] {
  const root: FileNode[] = [];
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    let level = root;
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index];
      const path = parts.slice(0, index + 1).join('/');
      const isLeaf = index === parts.length - 1;
      let node = level.find((item) => item.name === name);
      if (!node) {
        node = { name, path, type: isLeaf ? file.type : 'directory', ...(isLeaf && file.type === 'file' ? {} : { children: [] }) };
        level.push(node);
      }
      if (!isLeaf) level = node.children ?? (node.children = []);
    }
  }
  return root;
}
