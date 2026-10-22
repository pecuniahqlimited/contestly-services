# Local Firebase Auth emulator for the sims and local work (a "demo-" project needs no credentials).
# Auth is the only emulator we run; it needs no Java.
FROM node:22-alpine
RUN npm install -g firebase-tools@13
WORKDIR /firebase
COPY firebase.json .
EXPOSE 9099
CMD ["firebase", "emulators:start", "--only", "auth", "--project", "demo-contestly"]
