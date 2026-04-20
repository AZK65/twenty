# syntax=docker/dockerfile:1.6

# Base image for common dependencies
FROM node:24-alpine AS common-deps

WORKDIR /app

COPY ./package.json ./yarn.lock ./.yarnrc.yml ./tsconfig.base.json ./nx.json /app/
COPY ./.yarn/releases /app/.yarn/releases
COPY ./.yarn/patches /app/.yarn/patches

COPY ./packages/twenty-emails/package.json /app/packages/twenty-emails/
COPY ./packages/twenty-server/package.json /app/packages/twenty-server/
COPY ./packages/twenty-server/patches /app/packages/twenty-server/patches
COPY ./packages/twenty-ui/package.json /app/packages/twenty-ui/
COPY ./packages/twenty-shared/package.json /app/packages/twenty-shared/
COPY ./packages/twenty-front/package.json /app/packages/twenty-front/
COPY ./packages/twenty-sdk/package.json /app/packages/twenty-sdk/

# Cache yarn downloads across builds — saves ~2-3 min per push when lockfile unchanged
RUN --mount=type=cache,id=yarn-berry,target=/root/.yarn/berry/cache,sharing=locked \
    --mount=type=cache,id=yarn-local,target=/app/.yarn/cache,sharing=locked \
    yarn install --immutable && npx nx reset


# Build shared packages (used by both frontend and backend)
FROM common-deps AS shared-build

COPY ./packages/twenty-shared /app/packages/twenty-shared
COPY ./packages/twenty-sdk /app/packages/twenty-sdk
COPY ./packages/twenty-emails /app/packages/twenty-emails
COPY ./packages/twenty-ui /app/packages/twenty-ui


# Build the backend
FROM shared-build AS twenty-server-build

COPY ./packages/twenty-server /app/packages/twenty-server

# Nx cache speeds up rebuilds when only non-server code changed
RUN --mount=type=cache,id=nx-server,target=/app/.nx/cache,sharing=locked \
    npx nx run twenty-server:build
RUN --mount=type=cache,id=yarn-berry,target=/root/.yarn/berry/cache,sharing=locked \
    --mount=type=cache,id=yarn-local,target=/app/.yarn/cache,sharing=locked \
    yarn workspaces focus --production twenty-emails twenty-shared twenty-sdk twenty-server


# Build the frontend (cached separately — only rebuilds when front/ui/shared change)
FROM shared-build AS twenty-front-build

ARG REACT_APP_SERVER_BASE_URL
ENV REACT_APP_SERVER_BASE_URL=$REACT_APP_SERVER_BASE_URL

COPY ./packages/twenty-front /app/packages/twenty-front
RUN --mount=type=cache,id=nx-front,target=/app/.nx/cache,sharing=locked \
    --mount=type=cache,id=vite-cache,target=/app/packages/twenty-front/node_modules/.vite,sharing=locked \
    npx nx build twenty-front


# Final stage
FROM node:24-alpine AS twenty

RUN apk add --no-cache curl jq postgresql-client
RUN npm install -g tsx

COPY ./packages/twenty-docker/twenty/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

WORKDIR /app/packages/twenty-server

COPY --chown=1000 --from=twenty-server-build /app /app
COPY --chown=1000 --from=twenty-front-build /app/packages/twenty-front/build /app/packages/twenty-server/dist/front

RUN mkdir -p /app/.local-storage /app/packages/twenty-server/.local-storage && \
    chown 1000:1000 /app/.local-storage /app/packages/twenty-server/.local-storage

USER 1000

CMD ["node", "dist/main"]
ENTRYPOINT ["/app/entrypoint.sh"]
