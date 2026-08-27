import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { apiForTarget } from '../../app/api';
import { targetForResource, type ApiTarget } from '../../app/apiTargets';
import type { FileNode, Tab } from '../../app/types';
import { usePolling } from '../../app/usePolling';

type WorkspaceFile = { path: string; type: 'file' | 'directory' };

type UseWorkspaceFilesOptions = {
  selectedAgentId: string;
  targets: ApiTarget[];
  setTabs: Dispatch<SetStateAction<Tab[]>>;
  setActiveTabId: Dispatch<SetStateAction<string>>;
};

export function useWorkspaceFiles({ selectedAgentId, targets, setTabs, setActiveTabId }: UseWorkspaceFilesOptions) {
  const [workspaceFiles, setWorkspaceFiles] = useState<FileNode[]>([]);
  const ownerFor = useCallback((agentId: string) => targetForResource(targets, agentId), [targets]);
  useEffect(() => { setWorkspaceFiles([]); }, [selectedAgentId]);

  const refreshWorkspaceFiles = useCallback(async (agentId: string, shouldCommit: () => boolean = () => true) => {
    const owner = ownerFor(agentId);
    const { files } = await apiForTarget<{ files: WorkspaceFile[] }>(owner.target, `/api/workspace/files?agentId=${encodeURIComponent(owner.resourceId)}&scope=agent`);
    if (!shouldCommit()) return;
    const nextFiles = fileTreeFromPaths(files);
    setWorkspaceFiles((current) => JSON.stringify(current) === JSON.stringify(nextFiles) ? current : nextFiles);
  }, [ownerFor]);

  usePolling(async (isCancelled) => {
    if (!selectedAgentId) {
      if (!isCancelled()) setWorkspaceFiles([]);
      return;
    }
    try { await refreshWorkspaceFiles(selectedAgentId, () => !isCancelled()); } catch { /* Keep the last known tree. */ }
  }, 2_000, true, selectedAgentId);

  const openFile = useCallback(async (file: FileNode) => {
    if (file.type !== 'file' || !selectedAgentId) return;
    const agentId = selectedAgentId;
    const owner = ownerFor(agentId);
    const tabId = `${agentId}:${file.path}`;
    setTabs((all) => all.some((tab) => tab.id === tabId) ? all : [...all, {
      id: tabId, path: file.path, label: file.name, kind: 'file', content: 'Loading…', workspaceAgentId: agentId, targetId: owner.target.id,
    }]);
    setActiveTabId(tabId);
    try {
      const { content } = await apiForTarget<{ content: string }>(owner.target, `/api/workspace/file?agentId=${encodeURIComponent(owner.resourceId)}&scope=agent&path=${encodeURIComponent(file.path)}`);
      setTabs((all) => all.map((tab) => tab.id === tabId ? { ...tab, content } : tab));
    } catch (error) {
      setTabs((all) => all.map((tab) => tab.id === tabId ? { ...tab, content: `Could not read ${file.path}: ${(error as Error).message}` } : tab));
    }
  }, [ownerFor, selectedAgentId, setActiveTabId, setTabs]);

  const saveFile = useCallback(async (tab: Tab, content: string) => {
    if (!tab.workspaceAgentId || !tab.path) throw new Error('No agent workspace file is selected.');
    const owner = ownerFor(tab.workspaceAgentId);
    const result = await apiForTarget<{ content: string }>(owner.target, '/api/workspace/file', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: owner.resourceId, scope: 'agent', path: tab.path, content }),
    });
    setTabs((all) => all.map((item) => item.id === tab.id ? { ...item, content: result.content } : item));
  }, [ownerFor, setTabs]);

  return { workspaceFiles, refreshWorkspaceFiles, openFile, saveFile };
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
