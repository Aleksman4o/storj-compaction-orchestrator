FROM golang:1.26-alpine AS build
WORKDIR /src
RUN apk add --no-cache build-base
COPY . .
ARG VERSION=development
RUN CGO_ENABLED=1 go build -buildvcs=false -trimpath \
    -tags="osusergo netgo sqlite_omit_load_extension" \
    -ldflags="-s -w -X main.version=${VERSION} -linkmode external -extldflags '-static'" \
    -o /out/storj-compaction-orchestrator .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates \
    && addgroup -S orchestrator \
    && adduser -S -G orchestrator orchestrator \
    && mkdir /data \
    && chown orchestrator:orchestrator /data \
    && chmod 0700 /data
COPY --from=build /out/storj-compaction-orchestrator /usr/local/bin/storj-compaction-orchestrator
USER orchestrator
VOLUME ["/data"]
EXPOSE 14008
ENTRYPOINT ["/usr/local/bin/storj-compaction-orchestrator", "--database", "/data/orchestrator.db"]
