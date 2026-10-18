FROM nginx:1.27-alpine
RUN rm /etc/nginx/conf.d/default.conf
COPY nginx-container.conf /etc/nginx/conf.d/app.conf
COPY dist/ /usr/share/nginx/html/
