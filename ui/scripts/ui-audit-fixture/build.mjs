import { build } from 'vite';
import react from '@vitejs/plugin-react';
await build({configFile:false,root:new URL('.',import.meta.url).pathname,plugins:[react()],build:{outDir:'bundle',emptyOutDir:true}});
