// Jest config. Lives here rather than in package.json so the React Compiler can be enabled:
// babel-preset-expo only runs the compiler when the Babel caller says it supports it, which
// Metro does (app.json `experiments.reactCompiler`) but jest-expo's default caller does not.
// Without it, tests would miss bugs the compiler introduces, such as memoized render-time reads.
const jestExpo = require('jest-expo/jest-preset');

const JS_TRANSFORM = '\\.[jt]sx?$';
const [babelJest, babelOptions] = jestExpo.transform[JS_TRANSFORM];

/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  transform: {
    ...jestExpo.transform,
    [JS_TRANSFORM]: [babelJest, { ...babelOptions, caller: { ...babelOptions.caller, supportsReactCompiler: true } }],
  },
  testPathIgnorePatterns: ['/node_modules/', '/android/', '/ios/'],
  passWithNoTests: true,
  watchman: false,
  transformIgnorePatterns: [
    '/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|native-base|standard-navigation|@upstash|react-native-vision-camera|react-native-nitro-modules|react-native-nitro-image))',
    '/node_modules/react-native-reanimated/plugin/',
    '/node_modules/@react-native/babel-preset/',
  ],
  moduleNameMapper: {
    '^uncrypto$': '<rootDir>/node_modules/uncrypto/dist/crypto.web.cjs',
  },
};
