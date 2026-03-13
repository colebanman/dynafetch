import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import generate from '@babel/generator';
import * as t from '@babel/types';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const CACHE_DIR = path.join(process.cwd(), '.next/cache/phantom');
try {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
} catch {
  // Best-effort; cache writes are optional.
}

const memCache = new Map<string, string>();
let fsCacheEnabled = true;

export class Transformer {
  transform(code: string, scriptId: string): string {
    const hash = crypto.createHash('sha256').update(code).digest('hex');
    const cachePath = path.join(CACHE_DIR, `${hash}.js`);

    const memHit = memCache.get(hash);
    if (memHit) return memHit;
    
    if (fsCacheEnabled) {
      try {
        if (fs.existsSync(cachePath)) {
          const diskHit = fs.readFileSync(cachePath, 'utf-8');
          memCache.set(hash, diskHit);
          return diskHit;
        }
      } catch {
        // If the FS cache is flaky/slow, just disable it for this process.
        fsCacheEnabled = false;
      }
    }

    // Performance: request interception now happens via runtime shims in execute.ts.
    // Optional AST import() rewrite can be enabled if a target site depends on it.
    const needsRewrite =
      process.env.PHANTOM_ENABLE_AST_IMPORT_REWRITE === '1' &&
      code.includes('import(');

    if (!needsRewrite) {
      const passthrough = `try { ${code}\n } catch(e) { console.warn('Script ${scriptId} runtime error:', e); }`;
      memCache.set(hash, passthrough);
      if (fsCacheEnabled) {
        try {
          fs.writeFileSync(cachePath, passthrough);
        } catch {
          fsCacheEnabled = false;
        }
      }
      return passthrough;
    }

    let ast;
    try {
      ast = parse(code, {
        sourceType: 'unambiguous',
        plugins: ['typescript', 'jsx']
      });
    } catch (e) {
      const fallback = `try { ${code} } catch(e) { console.error('Script ${scriptId} failed:', e); }`;
      memCache.set(hash, fallback);
      if (fsCacheEnabled) {
        try {
          fs.writeFileSync(cachePath, fallback);
        } catch {
          fsCacheEnabled = false;
        }
      }
      return fallback;
    }

    traverse(ast, {
      CallExpression(path) {
        if (path.node.callee.type === 'Import') {
            path.replaceWith(
                t.callExpression(
                    t.memberExpression(
                        t.identifier('__phantom'),
                        t.identifier('dynamicImport')
                    ),
                    path.node.arguments
                )
            );
        }
      }
    });

    const output = generate(ast, { compact: true, minified: true }, code);
    
    const result = `try { 
      ${output.code} 
    } catch(e) { 
      console.warn('Script ${scriptId} runtime error:', e); 
    }`;
    
    memCache.set(hash, result);
    if (fsCacheEnabled) {
      try {
        fs.writeFileSync(cachePath, result);
      } catch {
        fsCacheEnabled = false;
      }
    }
    return result;
  }
}
