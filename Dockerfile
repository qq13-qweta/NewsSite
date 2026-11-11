FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
RUN mkdir -p data && chown node:node data
USER node
ENV PORT=8080
EXPOSE 8080
VOLUME /app/data
CMD ["node", "server.js"]
