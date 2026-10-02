# Urutau server image: one Node process serves the built app and /api.
#   docker build -t urutau .
#   docker run -p 127.0.0.1:8787:8080 -v urutau-data:/data urutau
# SQLite lives in the /data volume unless DATABASE_URL points elsewhere.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
# The type-check above needed the tests and their helpers; the runtime image does not.
# Nothing outside the tests imports server/testing, oidc/support.ts or oidc/fakeKeycloak.ts.
RUN find server src/domain -name '*.test.ts' -delete \
    && rm -rf server/testing server/oidc/support.ts server/oidc/fakeKeycloak.ts

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATABASE_URL=sqlite:/data/urutau.db
COPY package.json package-lock.json ./
# --omit=dev keeps the optional pg and mysql2 drivers.
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
# The server imports the shared types and API constants from src/domain.
COPY --from=build /app/src/domain ./src/domain
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
CMD ["node", "server/main.ts"]
