# Browser tests against the production image with the demo seed. Version must match @playwright/test.
FROM mcr.microsoft.com/playwright:v1.65.0-noble
WORKDIR /e2e
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
CMD ["npx", "playwright", "test"]
