import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const baseline = process.argv.includes('--baseline');
const changed = new Set([
  'ChatMessage.tsx',
  'useChatInputs.ts',
  'useChatRecovery.ts',
  'chatActivityProjection.ts',
  'useChatSession.ts',
]);
await build({
  entryPoints: ['scripts/chat-performance-fixture/fixture.tsx'],
  bundle: true,
  format: 'esm',
  outdir: `scripts/chat-performance-fixture/${baseline ? 'bundle-before' : 'bundle'}`,
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [
    {
      name: 'measure-chat-renders',
      setup(builder) {
        builder.onLoad({ filter: /src\/features\/chat\/.*\.(ts|tsx)$/ }, async ({ path }) => {
          const name = path.split('/').at(-1);
          let contents =
            baseline && changed.has(name)
              ? execFileSync('git', ['show', `cf509815:src/features/chat/${name}`], {
                  encoding: 'utf8',
                })
              : await readFile(path, 'utf8');
          if (name === 'ChatMessage.tsx') {
            contents = contents.replace(
              'return (\n    <ReactMarkdown',
              '(window as any).chatPerf.markdown++;\n  return (\n    <ReactMarkdown',
            );
            contents = contents.replace(
              "const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');\n  const image",
              "(window as any).chatPerf.messages++;\n  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');\n  const image",
            );
          }
          return {
            contents,
            loader: path.endsWith('tsx') ? 'tsx' : 'ts',
            resolveDir: resolve(path, '..'),
          };
        });
      },
    },
  ],
});
const { writeFile } = await import('node:fs/promises');
const dir = `scripts/chat-performance-fixture/${baseline ? 'bundle-before' : 'bundle'}`;
await writeFile(
  `${dir}/index.html`,
  (await readFile('scripts/chat-performance-fixture/index.html', 'utf8'))
    .replace('src="./fixture.tsx"', 'src="./fixture.js"')
    .replace('</head>', '<link rel="stylesheet" href="./fixture.css"/></head>'),
);

await writeFile(
  'scripts/chat-performance-fixture/burrow-logo.png',
  await readFile('public/burrow-logo.png'),
);
