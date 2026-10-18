# 注意：服务器 8.136.26.140 拉不动 Docker Hub（daocloud 加速器也偶发 502），
# 因此基于服务器本地已有的 alpine:3.22 镜像构建，apk 走阿里云内网源，不要改回 FROM nginx:...
FROM alpine:3.22

RUN sed -i "s#https://dl-cdn.alpinelinux.org#https://mirrors.aliyun.com#g" /etc/apk/repositories \
    && apk add --no-cache nginx

RUN rm -f /etc/nginx/http.d/default.conf
COPY nginx-container.conf /etc/nginx/http.d/app.conf
COPY dist/ /usr/share/nginx/html/

EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
