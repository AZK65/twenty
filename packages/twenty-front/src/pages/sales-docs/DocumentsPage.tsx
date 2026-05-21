import { getTokenPair } from '@/apollo/utils/getTokenPair';
import { PageTitle } from '@/ui/utilities/page-title/components/PageTitle';
import { styled } from '@linaria/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { REACT_APP_SERVER_BASE_URL } from '~/config';

type Folder = {
  id: string;
  name: string;
  parentId: string | null;
};

type DocFile = {
  id: string;
  folderId: string | null;
  name: string;
  fileUrl: string;
  description: string | null;
};

const PageRoot = styled.div`
  display: flex;
  height: 100%;
  width: 100%;
  overflow: hidden;
  background: var(--background-primary);
  color: var(--font-color-primary);
`;

const SidePane = styled.div`
  width: 260px;
  border-right: 1px solid var(--border-color-light);
  overflow-y: auto;
  padding: 16px 8px;
  flex-shrink: 0;
`;

const SidePaneHeader = styled.div`
  font-size: 13px;
  font-weight: 600;
  padding: 6px 12px;
  color: var(--font-color-secondary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
`;

const TreeNode = styled.div<{ active?: boolean; depth: number }>`
  padding: 6px 8px;
  padding-left: ${({ depth }) => 8 + depth * 16}px;
  font-size: 14px;
  cursor: pointer;
  border-radius: 4px;
  display: flex;
  align-items: center;
  gap: 6px;
  user-select: none;
  background: ${({ active }) =>
    active ? 'var(--background-tertiary)' : 'transparent'};
  &:hover {
    background: var(--background-tertiary);
  }
`;

const MainPane = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
`;

const TopBar = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 24px;
  border-bottom: 1px solid var(--border-color-light);
`;

const Breadcrumbs = styled.div`
  font-size: 14px;
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--font-color-secondary);
`;

const Crumb = styled.span<{ link?: boolean }>`
  cursor: ${({ link }) => (link ? 'pointer' : 'default')};
  color: ${({ link }) =>
    link ? 'var(--font-color-primary)' : 'var(--font-color-secondary)'};
  &:hover {
    text-decoration: ${({ link }) => (link ? 'underline' : 'none')};
  }
`;

const Button = styled.button`
  background: var(--blue);
  color: white;
  border: 0;
  padding: 6px 12px;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  &:hover {
    opacity: 0.9;
  }
  &.secondary {
    background: var(--background-tertiary);
    color: var(--font-color-primary);
    border: 1px solid var(--border-color-medium);
  }
`;

const Grid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 16px;
  padding: 24px;
  overflow-y: auto;
  flex: 1;
`;

const Card = styled.div`
  border: 1px solid var(--border-color-light);
  border-radius: 8px;
  padding: 16px;
  cursor: pointer;
  background: var(--background-secondary);
  display: flex;
  flex-direction: column;
  gap: 8px;
  position: relative;
  &:hover {
    border-color: var(--border-color-strong);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
  }
`;

const CardIcon = styled.div`
  font-size: 32px;
  line-height: 1;
`;

const CardName = styled.div`
  font-size: 14px;
  font-weight: 500;
  word-break: break-word;
`;

const CardMenu = styled.button`
  position: absolute;
  top: 6px;
  right: 6px;
  background: transparent;
  border: 0;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  color: var(--font-color-secondary);
  font-size: 18px;
  &:hover {
    background: var(--background-tertiary);
  }
`;

const Empty = styled.div`
  padding: 48px;
  text-align: center;
  color: var(--font-color-secondary);
  font-size: 14px;
`;

const ModalBackdrop = styled.div`
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
`;

const Modal = styled.div`
  background: var(--background-primary);
  border-radius: 8px;
  padding: 24px;
  width: 420px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
`;

const ModalTitle = styled.div`
  font-size: 16px;
  font-weight: 600;
`;

const Input = styled.input`
  border: 1px solid var(--border-color-medium);
  background: var(--background-secondary);
  color: var(--font-color-primary);
  padding: 8px 10px;
  border-radius: 4px;
  font-size: 14px;
  width: 100%;
`;

const ModalActions = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
`;

const apiBase = `${REACT_APP_SERVER_BASE_URL}/rest/sales-docs`;

const authHeaders = () => {
  const token = getTokenPair()?.accessOrWorkspaceAgnosticToken?.token;

  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
};

const api = {
  listFolders: async (): Promise<Folder[]> => {
    const r = await fetch(`${apiBase}/folders`, { headers: authHeaders() });

    if (!r.ok) throw new Error(`Failed to list folders (${r.status})`);

    return r.json();
  },
  createFolder: async (name: string, parentId: string | null) => {
    const r = await fetch(`${apiBase}/folders`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name, parentId }),
    });

    if (!r.ok) throw new Error(`Failed to create folder (${r.status})`);

    return r.json();
  },
  renameFolder: async (id: string, name: string) => {
    const r = await fetch(`${apiBase}/folders/${id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ name }),
    });

    if (!r.ok) throw new Error(`Failed to rename folder (${r.status})`);

    return r.json();
  },
  deleteFolder: async (id: string) => {
    const r = await fetch(`${apiBase}/folders/${id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });

    if (!r.ok) throw new Error(`Failed to delete folder (${r.status})`);

    return r.json();
  },
  listFiles: async (folderId: string | null): Promise<DocFile[]> => {
    const q = folderId ? `?folderId=${folderId}` : '?folderId=root';
    const r = await fetch(`${apiBase}/files${q}`, { headers: authHeaders() });

    if (!r.ok) throw new Error(`Failed to list files (${r.status})`);

    return r.json();
  },
  createFile: async (
    name: string,
    fileUrl: string,
    folderId: string | null,
  ) => {
    const r = await fetch(`${apiBase}/files`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name, fileUrl, folderId }),
    });

    if (!r.ok) throw new Error(`Failed to create file (${r.status})`);

    return r.json();
  },
  renameFile: async (id: string, name: string) => {
    const r = await fetch(`${apiBase}/files/${id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ name }),
    });

    if (!r.ok) throw new Error(`Failed to rename file (${r.status})`);

    return r.json();
  },
  deleteFile: async (id: string) => {
    const r = await fetch(`${apiBase}/files/${id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });

    if (!r.ok) throw new Error(`Failed to delete file (${r.status})`);

    return r.json();
  },
};

const childrenOf = (folders: Folder[], parentId: string | null): Folder[] =>
  folders.filter((f) => f.parentId === parentId);

const FolderTreeNode = ({
  folder,
  folders,
  depth,
  activeId,
  onSelect,
  expanded,
  toggleExpand,
}: {
  folder: Folder;
  folders: Folder[];
  depth: number;
  activeId: string | null;
  onSelect: (id: string | null) => void;
  expanded: Record<string, boolean>;
  toggleExpand: (id: string) => void;
}) => {
  const children = childrenOf(folders, folder.id);
  const isOpen = expanded[folder.id] ?? false;

  return (
    <>
      <TreeNode
        depth={depth}
        active={activeId === folder.id}
        onClick={() => onSelect(folder.id)}
      >
        <span
          onClick={(e) => {
            e.stopPropagation();
            toggleExpand(folder.id);
          }}
          style={{ width: 12, display: 'inline-block' }}
        >
          {children.length > 0 ? (isOpen ? '▾' : '▸') : ''}
        </span>
        <span>📁</span>
        <span>{folder.name}</span>
      </TreeNode>
      {isOpen &&
        children.map((c) => (
          <FolderTreeNode
            key={c.id}
            folder={c}
            folders={folders}
            depth={depth + 1}
            activeId={activeId}
            onSelect={onSelect}
            expanded={expanded}
            toggleExpand={toggleExpand}
          />
        ))}
    </>
  );
};

const breadcrumbsFor = (
  folders: Folder[],
  folderId: string | null,
): Folder[] => {
  const path: Folder[] = [];
  let cur = folderId;

  while (cur) {
    const f = folders.find((x) => x.id === cur);

    if (!f) break;
    path.unshift(f);
    cur = f.parentId;
  }

  return path;
};

export const DocumentsPage = () => {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [files, setFiles] = useState<DocFile[]>([]);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showFolderModal, setShowFolderModal] = useState(false);
  const [showFileModal, setShowFileModal] = useState(false);
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [fs, files] = await Promise.all([
        api.listFolders(),
        api.listFiles(currentFolderId),
      ]);

      setFolders(fs);
      setFiles(files);
    } catch (err) {
      console.error(err);
      // eslint-disable-next-line no-alert
      alert(`Failed to load documents: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [currentFolderId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const subfolders = useMemo(
    () => childrenOf(folders, currentFolderId),
    [folders, currentFolderId],
  );

  const crumbs = useMemo(
    () => breadcrumbsFor(folders, currentFolderId),
    [folders, currentFolderId],
  );

  const handleCreateFolder = async () => {
    const name = newName.trim();

    if (!name) return;
    try {
      await api.createFolder(name, currentFolderId);
      setNewName('');
      setShowFolderModal(false);
      await refresh();
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert((err as Error).message);
    }
  };

  const handleCreateFile = async () => {
    const name = newName.trim();
    const url = newUrl.trim();

    if (!name || !url) return;
    try {
      await api.createFile(name, url, currentFolderId);
      setNewName('');
      setNewUrl('');
      setShowFileModal(false);
      await refresh();
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert((err as Error).message);
    }
  };

  const handleRenameFolder = async (id: string, currentName: string) => {
    // eslint-disable-next-line no-alert
    const name = prompt('New folder name', currentName);

    if (!name || !name.trim()) return;
    await api.renameFolder(id, name.trim());
    await refresh();
  };

  const handleDeleteFolder = async (id: string) => {
    // eslint-disable-next-line no-alert
    if (!confirm('Delete this folder and everything inside?')) return;
    await api.deleteFolder(id);
    if (currentFolderId === id) setCurrentFolderId(null);
    await refresh();
  };

  const handleRenameFile = async (id: string, currentName: string) => {
    // eslint-disable-next-line no-alert
    const name = prompt('New file name', currentName);

    if (!name || !name.trim()) return;
    await api.renameFile(id, name.trim());
    await refresh();
  };

  const handleDeleteFile = async (id: string) => {
    // eslint-disable-next-line no-alert
    if (!confirm('Delete this file?')) return;
    await api.deleteFile(id);
    await refresh();
  };

  const toggleExpand = (id: string) =>
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  return (
    <>
      <PageTitle title="Documents" />
      <PageRoot>
        <SidePane>
          <SidePaneHeader>Folders</SidePaneHeader>
          <TreeNode
            depth={0}
            active={currentFolderId === null}
            onClick={() => setCurrentFolderId(null)}
          >
            <span style={{ width: 12 }} />
            <span>🏠</span>
            <span>All documents</span>
          </TreeNode>
          {childrenOf(folders, null).map((f) => (
            <FolderTreeNode
              key={f.id}
              folder={f}
              folders={folders}
              depth={0}
              activeId={currentFolderId}
              onSelect={setCurrentFolderId}
              expanded={expanded}
              toggleExpand={toggleExpand}
            />
          ))}
        </SidePane>
        <MainPane>
          <TopBar>
            <Breadcrumbs>
              <Crumb link onClick={() => setCurrentFolderId(null)}>
                Documents
              </Crumb>
              {crumbs.map((c) => (
                <span key={c.id} style={{ display: 'flex', gap: 6 }}>
                  <span>/</span>
                  <Crumb link onClick={() => setCurrentFolderId(c.id)}>
                    {c.name}
                  </Crumb>
                </span>
              ))}
            </Breadcrumbs>
            <Button
              className="secondary"
              onClick={() => {
                setNewName('');
                setShowFolderModal(true);
              }}
            >
              + New folder
            </Button>
            <Button
              onClick={() => {
                setNewName('');
                setNewUrl('');
                setShowFileModal(true);
              }}
            >
              + Add file
            </Button>
          </TopBar>
          {loading ? (
            <Empty>Loading…</Empty>
          ) : subfolders.length === 0 && files.length === 0 ? (
            <Empty>
              This folder is empty. Click <strong>+ New folder</strong> or{' '}
              <strong>+ Add file</strong> to get started.
            </Empty>
          ) : (
            <Grid>
              {subfolders.map((f) => (
                <Card key={f.id} onClick={() => setCurrentFolderId(f.id)}>
                  <CardIcon>📁</CardIcon>
                  <CardName>{f.name}</CardName>
                  <CardMenu
                    onClick={(e) => {
                      e.stopPropagation();
                      // eslint-disable-next-line no-alert
                      const action = prompt(
                        'Type "rename" or "delete"',
                        'rename',
                      );

                      if (action === 'rename') {
                        handleRenameFolder(f.id, f.name);
                      } else if (action === 'delete') {
                        handleDeleteFolder(f.id);
                      }
                    }}
                  >
                    ⋯
                  </CardMenu>
                </Card>
              ))}
              {files.map((file) => (
                <Card
                  key={file.id}
                  onClick={() => window.open(file.fileUrl, '_blank')}
                >
                  <CardIcon>📄</CardIcon>
                  <CardName>{file.name}</CardName>
                  <CardMenu
                    onClick={(e) => {
                      e.stopPropagation();
                      // eslint-disable-next-line no-alert
                      const action = prompt(
                        'Type "rename" or "delete"',
                        'rename',
                      );

                      if (action === 'rename') {
                        handleRenameFile(file.id, file.name);
                      } else if (action === 'delete') {
                        handleDeleteFile(file.id);
                      }
                    }}
                  >
                    ⋯
                  </CardMenu>
                </Card>
              ))}
            </Grid>
          )}
        </MainPane>
      </PageRoot>
      {showFolderModal && (
        <ModalBackdrop onClick={() => setShowFolderModal(false)}>
          <Modal onClick={(e) => e.stopPropagation()}>
            <ModalTitle>New folder</ModalTitle>
            <Input
              placeholder="Folder name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && handleCreateFolder()}
            />
            <ModalActions>
              <Button
                className="secondary"
                onClick={() => setShowFolderModal(false)}
              >
                Cancel
              </Button>
              <Button onClick={handleCreateFolder}>Create</Button>
            </ModalActions>
          </Modal>
        </ModalBackdrop>
      )}
      {showFileModal && (
        <ModalBackdrop onClick={() => setShowFileModal(false)}>
          <Modal onClick={(e) => e.stopPropagation()}>
            <ModalTitle>Add file</ModalTitle>
            <Input
              placeholder="File name (e.g. Pitch Deck Q3)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
            />
            <Input
              placeholder="Link (Google Drive, Dropbox, https://…)"
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateFile()}
            />
            <ModalActions>
              <Button
                className="secondary"
                onClick={() => setShowFileModal(false)}
              >
                Cancel
              </Button>
              <Button onClick={handleCreateFile}>Add</Button>
            </ModalActions>
          </Modal>
        </ModalBackdrop>
      )}
    </>
  );
};
