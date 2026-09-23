# Node reference registry (the same server `npm run dev` starts), packaged so
# self-hosting is `docker compose up` instead of a clone + two installs.
# The server imports sdk-js/src by relative path, so both packages go in.
FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
COPY sdk-js/package.json sdk-js/package-lock.json ./sdk-js/
RUN cd sdk-js && npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src
COPY sdk-js/src ./sdk-js/src

RUN mkdir /data && chown node:node /data
ENV NODE_ENV=production PORT=4021 INAM_DATA_DIR=/data
VOLUME /data
EXPOSE 4021
USER node
CMD ["npx", "tsx", "src/index.ts"]
