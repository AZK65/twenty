import { currentUserState } from '@/auth/states/currentUserState';
import { useAtomStateValue } from '@/ui/utilities/state/jotai/hooks/useAtomStateValue';
import { useMemo } from 'react';
import { AppPath } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';

// Landing page is the custom Home dashboard (/home). Unauthenticated users are
// sent to sign-in. Previously this resolved to the first/last-visited object's
// record page; that behavior is intentionally replaced by the Home dashboard.
export const useDefaultHomePagePath = () => {
  const currentUser = useAtomStateValue(currentUserState);

  const defaultHomePagePath = useMemo(() => {
    if (!isDefined(currentUser)) {
      return AppPath.SignInUp;
    }

    return '/home';
  }, [currentUser]);

  return { defaultHomePagePath };
};
