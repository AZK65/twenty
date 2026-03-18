import { tokenPairState } from '@/auth/states/tokenPairState';
import { jotaiStore } from '@/ui/utilities/state/jotai/jotaiStore';
import { type AuthTokenPair } from '~/generated-metadata/graphql';

export const getTokenPair = (): AuthTokenPair | undefined => {
  return jotaiStore.get(tokenPairState.atom) ?? undefined;
};
