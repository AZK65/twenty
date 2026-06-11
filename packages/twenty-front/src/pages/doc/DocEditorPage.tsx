import { getTokenPair } from '@/apollo/utils/getTokenPair';
import { PageTitle } from '@/ui/utilities/page-title/components/PageTitle';
import { styled } from '@linaria/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { themeCssVariables } from 'twenty-ui/theme-constants';
import { REACT_APP_SERVER_BASE_URL } from '~/config';

type DocEditorPageProps = {
  slug: string;
  title: string;
};

const authHeaders = () => {
  const token = getTokenPair()?.accessOrWorkspaceAgnosticToken?.token;

  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
};

const StyledContainer = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  padding: 24px;
`;

const StyledHeaderRow = styled.div`
  align-items: baseline;
  display: flex;
  gap: 12px;
`;

const StyledHeader = styled.h1`
  font-size: 22px;
  font-weight: 700;
  margin: 0;
`;

const StyledStatus = styled.span`
  color: ${themeCssVariables.font.color.light};
  font-size: 12px;
`;

const StyledTextArea = styled.textarea`
  background: ${themeCssVariables.background.primary};
  border: 1px solid ${themeCssVariables.border.color.light};
  border-radius: 8px;
  color: ${themeCssVariables.font.color.primary};
  flex: 1;
  font-family: inherit;
  font-size: 15px;
  line-height: 1.6;
  outline: none;
  padding: 24px;
  resize: none;
  width: 100%;
`;

export const DocEditorPage = ({ slug, title }: DocEditorPageProps) => {
  const [content, setContent] = useState('');
  const [status, setStatus] = useState('');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const apiBase = `${REACT_APP_SERVER_BASE_URL}/rest/docs/${slug}`;

  useEffect(() => {
    void (async () => {
      const response = await fetch(apiBase, { headers: authHeaders() });

      if (response.ok) {
        const doc = await response.json();
        setContent(doc.content ?? '');
      }
    })();
  }, [apiBase]);

  const save = useCallback(
    async (value: string) => {
      setStatus('Saving…');
      await fetch(apiBase, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ title, content: value }),
      });
      setStatus('Saved');
    },
    [apiBase, title],
  );

  const handleChange = (value: string) => {
    setContent(value);
    setStatus('Editing…');

    if (saveTimer.current !== null) {
      clearTimeout(saveTimer.current);
    }

    saveTimer.current = setTimeout(() => void save(value), 800);
  };

  return (
    <StyledContainer>
      <PageTitle title={title} />
      <StyledHeaderRow>
        <StyledHeader>{title}</StyledHeader>
        <StyledStatus>{status}</StyledStatus>
      </StyledHeaderRow>
      <StyledTextArea
        value={content}
        placeholder="Start typing…"
        onChange={(event) => handleChange(event.target.value)}
        onBlur={() => void save(content)}
      />
    </StyledContainer>
  );
};
