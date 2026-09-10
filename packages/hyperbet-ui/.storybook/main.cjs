const { resolve } = require("node:path");
const { mergeConfig } = require("vite");

const packageRoot = resolve(__dirname, "..");
const uiSrc = resolve(packageRoot, "./src");
const uiSrcNormalized = `${uiSrc.split("\\").join("/")}/`;

function createScopedMockPlugin() {
  const overrides = new Map([
    [
      "../spectator/useStreamingState",
      resolve(__dirname, "./mocks/useStreamingState.ts"),
    ],
    ["../lib/programs", resolve(__dirname, "./mocks/programs.ts")],
  ]);

  return {
    name: "hyperbet-storybook-scoped-mocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer) return null;
      const normalizedImporter = importer.split("\\").join("/");
      if (!normalizedImporter.startsWith(uiSrcNormalized)) return null;
      return overrides.get(source) ?? null;
    },
  };
}

/** @type {import('@storybook/react-vite').StorybookConfig} */
module.exports = {
  stories: ["../stories/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-essentials"],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  staticDirs: [resolve(packageRoot, "../hyperbet-solana/app/public")],
  async viteFinal(baseConfig) {
    return mergeConfig(baseConfig, {
      plugins: [createScopedMockPlugin()],
      resolve: {
        alias: [
          {
            find: /^@hyperbet\/ui\/(.*)$/,
            replacement: resolve(packageRoot, "./src/$1"),
          },
          {
            find: "@hyperbet/ui",
            replacement: resolve(packageRoot, "./src/index.ts"),
          },
        ],
      },
    });
  },
};
