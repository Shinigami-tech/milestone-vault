# SiteDoctor sandbox image: a throwaway browser that audits one site and is destroyed afterwards.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /opt/sitedoctor
RUN npm init -y >/dev/null && npm install --omit=dev playwright@1.63.0 axe-core@4.14.0 && npm cache clean --force
COPY runner.mjs toolbox.js ./

# Never run as root inside the sandbox.
USER pwuser
ENV NODE_ENV=production
ENTRYPOINT ["node", "/opt/sitedoctor/runner.mjs"]
