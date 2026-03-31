FROM zeabur/caddy-static

COPY index.html /usr/share/caddy/index.html
COPY library.html /usr/share/caddy/library.html

EXPOSE 8080
