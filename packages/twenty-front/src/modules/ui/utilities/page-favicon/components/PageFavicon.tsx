import { workspacePublicDataState } from '@/auth/states/workspacePublicDataState';
import { DEFAULT_WORKSPACE_LOGO } from '@/ui/navigation/navigation-drawer/constants/DefaultWorkspaceLogo';
import { Helmet } from 'react-helmet-async';
import { useEffect, useState } from 'react';
import { useAtomStateValue } from '@/ui/utilities/state/jotai/hooks/useAtomStateValue';
import { getImageAbsoluteURI } from 'twenty-shared/utils';
import { REACT_APP_SERVER_BASE_URL } from '~/config';

// Probe the workspace logo URL via a throwaway Image before swapping the
// favicon. If the image fails to load (404, wrong format, etc.), fall back
// to the default so the tab never ends up with a broken icon.
export const PageFavicon = () => {
  const workspacePublicData = useAtomStateValue(workspacePublicDataState);

  const candidate = workspacePublicData?.logo
    ? (getImageAbsoluteURI({
        imageUrl: workspacePublicData.logo,
        baseUrl: REACT_APP_SERVER_BASE_URL,
      }) ?? DEFAULT_WORKSPACE_LOGO)
    : DEFAULT_WORKSPACE_LOGO;

  const [href, setHref] = useState<string>(DEFAULT_WORKSPACE_LOGO);

  useEffect(() => {
    if (!candidate || candidate === DEFAULT_WORKSPACE_LOGO) {
      setHref(DEFAULT_WORKSPACE_LOGO);

      return;
    }

    let cancelled = false;
    const img = new Image();

    img.onload = () => {
      if (!cancelled) setHref(candidate);
    };
    img.onerror = () => {
      if (!cancelled) setHref(DEFAULT_WORKSPACE_LOGO);
    };
    img.src = candidate;

    return () => {
      cancelled = true;
    };
  }, [candidate]);

  return (
    <Helmet>
      <link rel="icon" type="image/x-icon" href={href} />
    </Helmet>
  );
};
