import { expect, assert } from 'chai';
import * as path from 'path';
import * as url from 'url';

import * as im from 'immutable';

import * as ast from '../../../compiler/lexical-analysis/ast';
import * as editor from '../../../compiler/editor';
import * as lexical from '../../../compiler/lexical-analysis/lexical';

const wd = path.resolve(".");

class TestLibPathResolver extends editor.LibPathResolver {
  private fs = im.Set<string>([
    "/usr/share/file1.libsonnet",
    `${wd}/file2.libsonnet`,
    "/usr/share/file3.libsonnet",
  ]);

  constructor() {
    super();

    this.libPaths = im.List<string>([
      "/usr/share",
    ]);
  }

  protected pathExists = (path: string): boolean => {
    return this.fs.contains(path);
  }
};

class SuccessTest {
  constructor(
    public readonly title: string,
    public readonly inputPath: string | ast.Import,
    public readonly targetPath: string,
  ) {}
}

const dummyLoc = new lexical.Location(-1, -1);

const successTests = im.List<SuccessTest>([
  new SuccessTest(
    "Resolves simple absolute path",
    "file:///usr/share/file1.libsonnet",
    "file:///usr/share/file1.libsonnet"),
  new SuccessTest(
    "Resolves simple file imported from lib path",
    new ast.Import(
      "file1.libsonnet",
      lexical.MakeLocationRange("test.jsonnet", dummyLoc, dummyLoc)),
      "file:///usr/share/file1.libsonnet"),
  new SuccessTest(
    "Resolves simple file imported from current directory",
    new ast.Import(
      "file2.libsonnet",
      lexical.MakeLocationRange("test.jsonnet", dummyLoc, dummyLoc)),
      `file://${wd}/file2.libsonnet`),
  new SuccessTest(
    "Resolves simple file imported absolute path",
    new ast.Import(
      "/usr/share/file3.libsonnet",
      lexical.MakeLocationRange("test.jsonnet", dummyLoc, dummyLoc)),
    "file:///usr/share/file3.libsonnet"),
]);

describe("Successfully search library paths for Jsonnet library", () => {
  const resolver = new TestLibPathResolver();

  for (let test of successTests.toArray()) {
    it(`${test.title}`, () => {
      const actual = <url.Url>resolver.resolvePath(test.inputPath);
      assert.isNotNull(actual);
      assert.equal(actual.protocol, "file:");
      assert.equal(actual.href, test.targetPath);
    });
  }
});