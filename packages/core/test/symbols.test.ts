import { describe, expect, it } from 'vitest';
import { extractSymbols, findSymbols, pluginForFile, symbolsAtRange } from '../src/index.js';
import type { SymbolInfo } from '../src/index.js';

const ok = async (file: string, source: string): Promise<SymbolInfo[]> => {
  const res = await extractSymbols(file, source);
  if (res.status !== 'ok') throw new Error(`${res.status}: ${'reason' in res ? res.reason : ''}`);
  return res.symbols;
};
const summary = (symbols: SymbolInfo[]) => symbols.map((s) => `${s.kind} ${s.name} ${s.range.join('-')}`);

const TS = `import { x } from './x';

export const LIMIT = 3;
const hidden = 'a';

export function retry(fn: () => void, attempts = LIMIT) {
  function inner() {
    return 1;
  }
  for (let i = 0; i < attempts; i++) fn();
}

export class Widget extends Base {
  private size = 1;
  constructor(public name: string) {
    super();
  }
  render(): string {
    return this.name;
  }
  static make(): Widget {
    return new Widget('w');
  }
}

export interface Shape {
  area(): number;
}

export type Id = string | number;

export enum Mode {
  On,
  Off,
}

namespace Util {
  export function helper() {}
}

export const double = (n: number) => n * 2;
`;

describe('TypeScript symbols', () => {
  it('lists definitions with qualified names, kinds and lines', async () => {
    expect(summary(await ok('a.ts', TS))).toEqual([
      'variable LIMIT 3-3',
      'variable hidden 4-4',
      'function retry 6-11',
      'class Widget 13-24',
      'method Widget.constructor 15-17',
      'method Widget.render 18-20',
      'method Widget.make 21-23',
      'interface Shape 26-28',
      'method Shape.area 27-27',
      'type Id 30-30',
      'enum Mode 32-35',
      'namespace Util 37-39',
      'function Util.helper 38-38',
      'function double 41-41',
    ]);
  });

  it('does not report locals declared inside functions', async () => {
    const names = (await ok('a.ts', TS)).map((s) => s.name);
    expect(names).not.toContain('inner');
  });

  it('parses TSX and JavaScript', async () => {
    const tsx = await ok('c.tsx', 'export function App() {\n  return <div />;\n}\n');
    expect(summary(tsx)).toEqual(['function App 1-3']);
    const js = await ok('c.js', 'class A {\n  go() {}\n}\nconst f = () => 1;\n');
    expect(summary(js)).toEqual(['class A 1-3', 'method A.go 2-2', 'function f 4-4']);
  });
});

const JAVA = `package com.example;

import java.util.List;

public class Service {
    private final int limit = 3;

    public Service() {
        this.limit = 3;
    }

    public Result process(Order order) {
        return null;
    }

    public Result process(Order order, int qty) {
        return null;
    }

    static class Inner {
        int get() { return 1; }
    }
}

interface Auditable {
    void log();
}

enum Level { LOW, HIGH }

record Point(int x, int y) {}
`;

describe('Java symbols', () => {
  it('lists classes, nested types, constructors, overloads and fields', async () => {
    expect(summary(await ok('Service.java', JAVA))).toEqual([
      'class Service 5-23',
      'field Service.limit 6-6',
      'method Service.Service 8-10',
      'method Service.process 12-14',
      'method Service.process 16-18',
      'class Service.Inner 20-22',
      'method Service.Inner.get 21-21',
      'interface Auditable 25-27',
      'method Auditable.log 26-26',
      'enum Level 29-29',
      'class Point 31-31',
    ]);
  });
});

describe('lookups', () => {
  it('finds the innermost symbols around a range, and none at file scope', async () => {
    const symbols = await ok('a.ts', TS);
    expect(symbolsAtRange(symbols, [19, 19]).map((s) => s.name)).toEqual(['Widget.render', 'Widget']);
    expect(symbolsAtRange(symbols, [1, 1])).toEqual([]);
  });

  it('matches exact qualified names first, then trailing names, and reports ambiguity as several results', async () => {
    const java = await ok('Service.java', JAVA);
    expect(findSymbols(java, 'Service.process')).toHaveLength(2);
    expect(findSymbols(java, 'Inner.get').map((s) => s.name)).toEqual(['Service.Inner.get']);
    expect(findSymbols(java, 'get').map((s) => s.name)).toEqual(['Service.Inner.get']);
    expect(findSymbols(java, 'Service')).toHaveLength(1); // exact beats the Service.Service constructor
    expect(findSymbols(java, 'nope')).toEqual([]);
  });
});

describe('unsupported and broken input', () => {
  it('reports unsupported file types and does not throw on garbage', async () => {
    expect(await extractSymbols('notes.txt', 'hello')).toMatchObject({ status: 'unsupported' });
    expect(pluginForFile('x.TS')?.id).toBe('typescript');
    const res = await extractSymbols('broken.ts', 'function ( { ]]]');
    expect(['ok', 'failed']).toContain(res.status);
  });
});
