# FROM busybox:stable（宿主机已有，kind 节点可离线加载）。两个静态二进制由 deploy.sh 交叉编译后放进 build/。
FROM busybox:stable
ARG BIN_DIR=build
COPY ${BIN_DIR}/loom /usr/local/bin/loom
COPY ${BIN_DIR}/loom-mock /usr/local/bin/loom-mock
RUN adduser -D -u 65534 nobody2 2>/dev/null; chmod 755 /usr/local/bin/loom /usr/local/bin/loom-mock
USER 65534:65534
ENTRYPOINT ["/usr/local/bin/loom"]
