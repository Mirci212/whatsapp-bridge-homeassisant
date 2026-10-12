FROM node:20-alpine

# FFmpeg für Audio-Transkodierung (WAHA-Medien -> WAV für HA-STT)
RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

RUN chmod +x /app/run.sh

CMD [ "/app/run.sh" ]