import { expect, assert } from 'chai';
import * as fs from 'fs';
import * as mocha from 'mocha';
import * as os from 'os';
import * as url from 'url';

import * as ast from '../../compiler/lexical-analysis/ast';
import * as editor from '../../compiler/editor';
import * as lexical from '../../compiler/lexical-analysis/lexical';
import * as lexer from '../../compiler/lexical-analysis/lexer';
import * as local from '../../server/local';
import * as _static from '../../compiler/static';
import * as testWorkspace from './test_workspace';

const dataDir = `${__dirname}/../../../test/data`;

const makeLocation = (line: number, column: number): lexical.Location => {
  return new lexical.Location(line, column);
}

const assertLocationRange = (
  lr: lexical.LocationRange, startLine: number, startCol: number,
  endLine: number, endCol: number
): void => {
  assert.equal(lr.begin.line, startLine);
  assert.equal(lr.begin.column, startCol);
  assert.equal(lr.end.line, endLine);
  assert.equal(lr.end.column, endCol);
}

const resolveSymbolAtPositionFromAst = (
  analyzer: _static.Analyzer, context: ast.ResolutionContext,
  rootNode: ast.Node, pos: lexical.Location,
): ast.Node | null => {
  let nodeAtPos = _static.getNodeAtPositionFromAst(rootNode, pos);
  if (ast.isAnalyzableFindFailure(nodeAtPos)) {
    nodeAtPos = nodeAtPos.tightestEnclosingNode;
  } else if (ast.isUnanalyzableFindFailure(nodeAtPos)) {
    return null;
  }

  if (!ast.isResolvable(nodeAtPos)) {
    return null;
  }

  const resolved = nodeAtPos.resolve(context);

  return !ast.isResolve(resolved) || !ast.isNode(resolved.value)
    ? null
    : resolved.value;
}

describe("Compiler service", () => {
  const mockFilename = "mockFile.jsonnet";
  const mockDocumentText1 = "{}";
  const mockDocumentText2 = "[]";

  it("returns cached parse if document versions are the same", () => {
    const compilerService = new local.VsCompilerService();

    {
      const cachedParse1 = compilerService.cache(
        mockFilename, mockDocumentText1, 1);
      assert.isTrue(_static.isParsedDocument(cachedParse1));
      assert.equal(cachedParse1.text, mockDocumentText1);
      assert.equal(cachedParse1.version, 1);
      assert.isTrue(
        !_static.isLexFailure(cachedParse1.parse) &&
        !_static.isParseFailure(cachedParse1.parse) &&
        cachedParse1.parse.type == "ObjectNode");
    }

    {
      // Return the cached parse if the versions are the same, instead
      // of parsing the new document text.
      const cachedParse2 = compilerService.cache(
        mockFilename, mockDocumentText2, 1);
      assert.isTrue(_static.isParsedDocument(cachedParse2));
      assert.equal(cachedParse2.text, mockDocumentText1);
      assert.equal(cachedParse2.version, 1);
      assert.isTrue(
        !_static.isLexFailure(cachedParse2.parse) &&
        !_static.isParseFailure(cachedParse2.parse) &&
        cachedParse2.parse.type == "ObjectNode");
    }

    {
      // Parse the new version of the document.
      const cachedParse3 = compilerService.cache(
        mockFilename, mockDocumentText2, 2);
      assert.isTrue(_static.isParsedDocument(cachedParse3));
      assert.equal(cachedParse3.text, mockDocumentText2);
      assert.equal(cachedParse3.version, 2);
      assert.isTrue(
        !_static.isLexFailure(cachedParse3.parse) &&
        !_static.isParseFailure(cachedParse3.parse) &&
        cachedParse3.parse.type == "ArrayNode");
    }
  });

  it("always parses document if version is undefined", () => {
    const compilerService = new local.VsCompilerService();

    {
      const cachedParse1 = compilerService.cache(
        mockFilename, mockDocumentText1, undefined);
      assert.isTrue(_static.isParsedDocument(cachedParse1));
      assert.equal(cachedParse1.text, mockDocumentText1);
      assert.equal(cachedParse1.version, undefined);
      assert.isTrue(
        !_static.isLexFailure(cachedParse1.parse) &&
        !_static.isParseFailure(cachedParse1.parse) &&
        cachedParse1.parse.type == "ObjectNode");
    }

    {
      // Parse the new version of the document if version is
      // `undefined`.
      const cachedParse2 = compilerService.cache(
        mockFilename, mockDocumentText2, undefined);
      assert.isTrue(_static.isParsedDocument(cachedParse2));
      assert.equal(cachedParse2.text, mockDocumentText2);
      assert.equal(cachedParse2.version, undefined);
      assert.isTrue(
        !_static.isLexFailure(cachedParse2.parse) &&
        !_static.isParseFailure(cachedParse2.parse) &&
        cachedParse2.parse.type == "ArrayNode");
    }

    {
      // Parse the new version of the document if previous version was
      // `undefined`, but we now have a version number.
      const cachedParse3 = compilerService.cache(
        mockFilename, mockDocumentText1, 1);
      assert.isTrue(_static.isParsedDocument(cachedParse3));
      assert.equal(cachedParse3.text, mockDocumentText1);
      assert.equal(cachedParse3.version, 1);
      assert.isTrue(
        !_static.isLexFailure(cachedParse3.parse) &&
        !_static.isParseFailure(cachedParse3.parse) &&
        cachedParse3.parse.type == "ObjectNode");
    }

    {
      // Parse the new version of the document if we previously had a
      // version number, but now we don't.
      const cachedParse4 = compilerService.cache(
        mockFilename, mockDocumentText2, undefined);
      assert.isTrue(_static.isParsedDocument(cachedParse4));
      assert.equal(cachedParse4.text, mockDocumentText2);
      assert.equal(cachedParse4.version, undefined);
      assert.isTrue(
        !_static.isLexFailure(cachedParse4.parse) &&
        !_static.isParseFailure(cachedParse4.parse) &&
        cachedParse4.parse.type == "ArrayNode");
    }
  });
});

describe("Searching an AST by position", () => {
  const compilerService = new local.VsCompilerService();
  const documents =
    new testWorkspace.FsDocumentManager(new local.VsPathResolver());
  const analyzer = new _static.Analyzer(documents, compilerService);

  const file = `file://${dataDir}/simple-nodes.jsonnet`;
  const ctx = new ast.ResolutionContext(compilerService, documents, file);
  const doc = documents.get(file);
  const compiled = compilerService.cache(file, doc.text, doc.version);
  if (_static.isFailedParsedDocument(compiled)) {
    throw new Error(`Failed to parse document '${file}'`);
  }

  const rootNode = compiled.parse;

  it("Object field assigned value of `local` symbol", () => {
    // Property.
    {
      const property1Id = <ast.Identifier>_static.getNodeAtPositionFromAst(
        rootNode, makeLocation(2, 5));
      assert.isNotNull(property1Id);
      assert.equal(property1Id.type, "IdentifierNode");
      assert.equal(property1Id.name, "property1");
      assert.isNotNull(property1Id.parent);
      assertLocationRange(property1Id.loc, 2, 3, 2, 12);

      const property1Parent = <ast.ObjectField>property1Id.parent;
      assert.equal(property1Parent.type, "ObjectFieldNode");
      assert.equal(property1Parent.kind, "ObjectFieldID");
      assertLocationRange(property1Parent.loc, 2, 3, 2, 17);
    }

    // Target.
    {
      const target1Id = <ast.Identifier>_static.getNodeAtPositionFromAst(
        rootNode, makeLocation(2, 14));
      assert.isNotNull(target1Id);
      assert.equal(target1Id.type, "IdentifierNode");
      assert.equal(target1Id.name, "foo");
      assert.isNotNull(target1Id.parent);
      assertLocationRange(target1Id.loc, 2, 14, 2, 17);

      const target1Parent = <ast.Var>target1Id.parent;
      assert.equal(target1Parent.type, "VarNode");
      assert.isNotNull(target1Parent.parent);
      assertLocationRange(target1Parent.loc, 2, 14, 2, 17);

      const target1Grandparent = <ast.ObjectField>target1Parent.parent;
      assert.equal(target1Grandparent.type, "ObjectFieldNode");
      assert.equal(target1Grandparent.kind, "ObjectFieldID");
      assertLocationRange(target1Grandparent.loc, 2, 3, 2, 17);
    }
  });

  it("Object field assigned literal number", () => {
    // Target.
    const found =
      <ast.AnalyzableFindFailure>_static.getNodeAtPositionFromAst(
        rootNode, makeLocation(3, 15));
    assert.isTrue(ast.isAnalyzableFindFailure(found));
    assert.equal(found.kind, "NotIdentifier");

    const target2Id = <ast.LiteralNumber>found.tightestEnclosingNode;
    assert.equal(target2Id.type, "LiteralNumberNode");
    assert.equal(target2Id.originalString, "2");
    assert.isNotNull(target2Id.parent);
    assertLocationRange(target2Id.loc, 3, 14, 3, 15);

    const target2Parent = <ast.ObjectField>target2Id.parent;
    assert.equal(target2Parent.type, "ObjectFieldNode");
    assert.equal(target2Parent.kind, "ObjectFieldID");
    assertLocationRange(target2Parent.loc, 3, 3, 3, 15);
  });

  it("`local` object field assigned value", () => {
    // Property.
    {
      const property3Id = <ast.Identifier>_static.getNodeAtPositionFromAst(
        rootNode, makeLocation(4, 9));
      assert.isNotNull(property3Id);
      assert.equal(property3Id.type, "IdentifierNode");
      assert.equal(property3Id.name, "foo");
      assert.isNotNull(property3Id.parent);
      assertLocationRange(property3Id.loc, 4, 9, 4, 12);

      const property3Parent = <ast.ObjectField>property3Id.parent;
      assert.equal(property3Parent.type, "ObjectFieldNode");
      assert.equal(property3Parent.kind, "ObjectLocal");
      assertLocationRange(property3Parent.loc, 4, 3, 4, 16);
    }

    // Target.
    {
      const found =
        <ast.AnalyzableFindFailure>_static.getNodeAtPositionFromAst(
          rootNode, makeLocation(4, 15));
      assert.isTrue(ast.isAnalyzableFindFailure(found));
      assert.equal(found.kind, "NotIdentifier");

      const target3Id = <ast.LiteralNumber>found.tightestEnclosingNode;
      assert.isNotNull(target3Id);
      assert.equal(target3Id.type, "LiteralNumberNode");
      assert.equal(target3Id.originalString, "3");
      assert.isNotNull(target3Id.parent);
      assertLocationRange(target3Id.loc, 4, 15, 4, 16);

      const target3Parent = <ast.ObjectField>target3Id.parent;
      assert.equal(target3Parent.type, "ObjectFieldNode");
      assert.equal(target3Parent.kind, "ObjectLocal");
      assertLocationRange(target3Parent.loc, 4, 3, 4, 16);
    }
  });

  it("Resolution of `local` object fields is order-independent", () => {
    // This location points at the `baz` symbol in the expression
    // `bar.baz`, where `bar` is a `local` field that's declared below
    // the current field. This tests that we correctly resolve that
    // reference, even though it occurs after the current object
    // field.
    const property4Id = <ast.Identifier>_static.getNodeAtPositionFromAst(
      rootNode, makeLocation(5, 20));
    assert.isNotNull(property4Id);
    assert.equal(property4Id.type, "IdentifierNode");
    assert.equal(property4Id.name, "baz");

    const resolved = <ast.LiteralNumber>(<ast.Resolve>property4Id.resolve(ctx)).value;
    assert.equal(resolved.type, "LiteralNumberNode");
    assert.equal(resolved.originalString, "3");
  });

  it("Can resolve identifiers that refer to mixins", () => {
    // merged1.b
    {
      const merged1 = <ast.Identifier>_static.getNodeAtPositionFromAst(
        rootNode, makeLocation(11, 23));
      assert.isNotNull(merged1);
      assert.equal(merged1.type, "IdentifierNode");
      assert.equal(merged1.name, "b");

      const resolved = <ast.LiteralNumber>(<ast.Resolve>merged1.resolve(ctx)).value;
      assert.isNotNull(resolved);
      assert.equal(resolved.type, "LiteralNumberNode");
      assert.equal(resolved.originalString, "3");
    }

    // merged2.a
    {
      const merged2 = <ast.Identifier>_static.getNodeAtPositionFromAst(
        rootNode, makeLocation(11, 34));
      assert.isNotNull(merged2);
      assert.equal(merged2.type, "IdentifierNode");
      assert.equal(merged2.name, "a");

      const resolved = <ast.LiteralNumber>(<ast.Resolve>merged2.resolve(ctx)).value;
      assert.equal(resolved.type, "LiteralNumberNode");
      assert.equal(resolved.originalString, "99");
    }

    // merged3.a
    {
      const merged3 = <ast.Identifier>_static.getNodeAtPositionFromAst(
        rootNode, makeLocation(11, 45));
      assert.isNotNull(merged3);
      assert.equal(merged3.type, "IdentifierNode");
      assert.equal(merged3.name, "a");

      const resolved = <ast.LiteralNumber>(<ast.Resolve>merged3.resolve(ctx)).value;
      assert.equal(resolved.type, "LiteralNumberNode");
      assert.equal(resolved.originalString, "1");
    }

    // merged4.a
    {
      const merged4 = <ast.Identifier>_static.getNodeAtPositionFromAst(
        rootNode, makeLocation(11, 56));
      assert.isNotNull(merged4);
      assert.equal(merged4.type, "IdentifierNode");
      assert.equal(merged4.name, "a");

      const resolved = <ast.LiteralNumber>(<ast.Resolve>merged4.resolve(ctx)).value;
      assert.isNotNull(resolved);
      assert.equal(resolved.type, "LiteralNumberNode");
      assert.equal(resolved.originalString, "99");
    }

    // merged4.a
    {
      const merged5 = <ast.Identifier>_static.getNodeAtPositionFromAst(
        rootNode, makeLocation(15, 28));
      assert.isNotNull(merged5);
      assert.equal(merged5.type, "IdentifierNode");
      assert.equal(merged5.name, "a");

      const resolved = <ast.LiteralNumber>(<ast.Resolve>merged5.resolve(ctx)).value;
      assert.isNotNull(resolved);
      assert.equal(resolved.type, "LiteralNumberNode");
      assert.equal(resolved.originalString, "99");
    }
  });

  it("Can resolve identifiers that point to identifiers", () => {
    // Regression test. Tests that we can resolve a variable that
    // points to another variable. In this case, `numberVal2` refers
    // to `numberVal1`.

    const node = <ast.Identifier>_static.getNodeAtPositionFromAst(
      rootNode, makeLocation(18, 19));
    assert.isNotNull(node);
    assert.equal(node.type, "IdentifierNode");
    assert.equal(node.name, "numberVal2");

    const resolved = <ast.LiteralNumber>(<ast.Resolve>node.resolve(ctx)).value;
    assert.isNotNull(resolved);
    assert.equal(resolved.type, "LiteralNumberNode");
    assert.equal(resolved.originalString, "1");
  });
});

describe("Imported symbol resolution", () => {
  const compilerService = new local.VsCompilerService();
  const documents =
    new testWorkspace.FsDocumentManager(new local.VsPathResolver());
  const analyzer = new _static.Analyzer(documents, compilerService);

  const file = `file://${dataDir}/simple-import.jsonnet`;
  const document = documents.get(file);
  const compile = compilerService.cache(file, document.text, document.version);

  const ctx = new ast.ResolutionContext(compilerService, documents, file);

  if (_static.isFailedParsedDocument(compile)) {
    throw new Error(`Failed to parse document '${file}'`);
  }

  const rootNode = compile.parse;

  it("Can dereference the object that is imported", () => {
    const importedSymbol =
      <ast.Local>resolveSymbolAtPositionFromAst(
        analyzer, ctx, rootNode, makeLocation(4, 8));
    assert.isNotNull(importedSymbol);
    assert.equal(importedSymbol.type, "ObjectNode");
    assert.isNotNull(importedSymbol.parent);
    assertLocationRange(importedSymbol.loc, 2, 1, 52, 2);
  });

  it("Can dereference fields from an imported module", () => {
    // This location points at the `foo` symbol in the expression
    // `fooModule.foo`. This tests that we correctly resolve the
    // `fooModule` symbol as an import, then load the relevant file,
    // then resolve the `foo` symbol.
    const valueofObjectField =
      <ast.LiteralNumber>resolveSymbolAtPositionFromAst(
        analyzer, ctx, rootNode, makeLocation(5, 19));
    assert.isNotNull(valueofObjectField);
    assert.equal(valueofObjectField.type, "LiteralNumberNode");
    assert.equal(valueofObjectField.originalString, "99");
    assertLocationRange(valueofObjectField.loc, 4, 8, 4, 10);
  });

  it("Can find comments for a field in an imported module", () => {
    // This location points at the `foo` symbol in the expression
    // `fooModule.foo`, where `fooModule` is an imported module. This
    // tests that we can correctly obtain the documentation for this
    // symbol.
    const valueOfObjectField =
      <ast.LiteralNumber>resolveSymbolAtPositionFromAst(
        analyzer, ctx, rootNode, makeLocation(5, 19));
    assert.isNotNull(valueOfObjectField);
    const comments = analyzer.resolveComments(valueOfObjectField);
    assert.isNotNull(comments);
    assert.equal(
      comments, " `foo` is a property that has very useful data.");
  });

  it("Can find comments for a nested field in an imported module", () => {
    // This location points at the `bat` symbol in the expression
    // `fooModule.baz.bat`, where `fooModule` is an imported module.
    // This tests that we can correctly obtain the documentation for
    // a symbol that lies in a multiply-nested index node.
    const valueOfObjectField =
      <ast.LiteralString>resolveSymbolAtPositionFromAst(
        analyzer, ctx, rootNode, makeLocation(7, 23));
    assert.isNotNull(valueOfObjectField);
    assert.equal(valueOfObjectField.type, "LiteralStringNode");
    assert.equal(valueOfObjectField.value, "batVal");

    const comments = analyzer.resolveComments(valueOfObjectField);
    assert.isNotNull(comments);
    assert.equal(comments, " `bat` contains a fancy value, `batVal`.");
  });

  it("Cannot find comments for `local` field in an imported module", () => {
    // This location points at the `bar` symbol in the expression
    // `fooModule.bar`, where `fooModule` is an imported module. This
    // tests that we do not report documentation for this symbol, as
    // it is a `local` field.
    const valueOfObjectField =
      <ast.LiteralNumber>resolveSymbolAtPositionFromAst(
        analyzer, ctx, rootNode, makeLocation(6, 10));
    assert.isNotNull(valueOfObjectField);
    const comments = analyzer.resolveComments(valueOfObjectField);
    assert.isNull(comments);
  });

  it("Can find C-style comments", () => {
    // This location points at the `bat` symbol in the expression
    // `fooModule.baz.bat`, where `fooModule` is an imported module.
    // This tests that we can correctly obtain the documentation for
    // a symbol that lies in a multiply-nested index node.
    const valueOfObjectField =
      <ast.LiteralString>resolveSymbolAtPositionFromAst(
        analyzer, ctx, rootNode, makeLocation(8, 23));
    assert.isNotNull(valueOfObjectField);

    const comments = analyzer.resolveComments(valueOfObjectField);
    assert.isNotNull(comments);
    assert.equal(comments, " This comment should appear over `testField1`. ");
  });

  it("Find multi-line C-style comments", () => {
    // This location points at the `bat` symbol in the expression
    // `fooModule.baz.bat`, where `fooModule` is an imported module.
    // This tests that we can correctly obtain the documentation for
    // a symbol that lies in a multiply-nested index node.
    const valueOfObjectField =
      <ast.LiteralString>resolveSymbolAtPositionFromAst(
        analyzer, ctx, rootNode, makeLocation(9, 23));
    assert.isNotNull(valueOfObjectField);

    const comments = analyzer.resolveComments(valueOfObjectField);
    assert.isNotNull(comments);
    assert.equal(comments, " Line 1 of a comment that appears over `testField2`.\n Line 2 of a comment that appears over `testField2`.\n   ");
  });

  it("Ignore C-style comments that come before the heading comment", () => {
    // This location points at the `bat` symbol in the expression
    // `fooModule.baz.bat`, where `fooModule` is an imported module.
    // This tests that we can correctly obtain the documentation for
    // a symbol that lies in a multiply-nested index node.
    const valueOfObjectField =
      <ast.LiteralString>resolveSymbolAtPositionFromAst(
        analyzer, ctx, rootNode, makeLocation(10, 23));
    assert.isNotNull(valueOfObjectField);

    const comments = analyzer.resolveComments(valueOfObjectField);
    assert.isNotNull(comments);
    assert.equal(comments, " A comment for `testField3`.\n   ");
  });

  it("Find C-style comments that come before a comma", () => {
    // This location points at the `bat` symbol in the expression
    // `fooModule.baz.bat`, where `fooModule` is an imported module.
    // This tests that we can correctly obtain the documentation for
    // a symbol that lies in a multiply-nested index node.
    const valueOfObjectField =
      <ast.LiteralString>resolveSymbolAtPositionFromAst(
        analyzer, ctx, rootNode, makeLocation(11, 23));
    assert.isNotNull(valueOfObjectField);

    const comments = analyzer.resolveComments(valueOfObjectField);
    assert.isNotNull(comments);
    assert.equal(comments, " A comment for `testField4`. ");
  });

  it("Find C-style comments that come before a comma", () => {
    // This location points at the `bat` symbol in the expression
    // `fooModule.baz.bat`, where `fooModule` is an imported module.
    // This tests that we can correctly obtain the documentation for
    // a symbol that lies in a multiply-nested index node.
    const valueOfObjectField =
      <ast.LiteralString>resolveSymbolAtPositionFromAst(
        analyzer, ctx, rootNode, makeLocation(12, 23));
    assert.isNotNull(valueOfObjectField);

    const comments = analyzer.resolveComments(valueOfObjectField);
    assert.isNotNull(comments);
    assert.equal(comments, " A comment for `testField5`. ");
  });

  it("Find CPP-style comment after several other comment types", () => {
    // This location points at the `bat` symbol in the expression
    // `fooModule.baz.bat`, where `fooModule` is an imported module.
    // This tests that we can correctly obtain the documentation for
    // a symbol that lies in a multiply-nested index node.
    const valueOfObjectField =
      <ast.LiteralString>resolveSymbolAtPositionFromAst(
        analyzer, ctx, rootNode, makeLocation(13, 23));
    assert.isNotNull(valueOfObjectField);

    const comments = analyzer.resolveComments(valueOfObjectField);
    assert.isNotNull(comments);
    assert.equal(comments, " A comment for `testField6`.");
  });

  it("Find simple Hash-style comment", () => {
    // This location points at the `bat` symbol in the expression
    // `fooModule.baz.bat`, where `fooModule` is an imported module.
    // This tests that we can correctly obtain the documentation for
    // a symbol that lies in a multiply-nested index node.
    const valueOfObjectField =
      <ast.LiteralString>resolveSymbolAtPositionFromAst(
        analyzer, ctx, rootNode, makeLocation(14, 23));
    assert.isNotNull(valueOfObjectField);

    const comments = analyzer.resolveComments(valueOfObjectField);
    assert.isNotNull(comments);
    assert.equal(comments, " A comment for `testField7`.");
  });

  it("Find multi-line Hash-style comment", () => {
    // This location points at the `bat` symbol in the expression
    // `fooModule.baz.bat`, where `fooModule` is an imported module.
    // This tests that we can correctly obtain the documentation for
    // a symbol that lies in a multiply-nested index node.
    const valueOfObjectField =
      <ast.LiteralString>resolveSymbolAtPositionFromAst(
        analyzer, ctx, rootNode, makeLocation(15, 23));
    assert.isNotNull(valueOfObjectField);

    const comments = analyzer.resolveComments(valueOfObjectField);
    assert.isNotNull(comments);
    assert.equal(comments, " Line 1 of a comment for `testField8`.\n Line 2 of a comment for `testField8`.");
  });

  it("Find Hash-style comment before comma", () => {
    // This location points at the `bat` symbol in the expression
    // `fooModule.baz.bat`, where `fooModule` is an imported module.
    // This tests that we can correctly obtain the documentation for
    // a symbol that lies in a multiply-nested index node.
    const valueOfObjectField =
      <ast.LiteralString>resolveSymbolAtPositionFromAst(
        analyzer, ctx, rootNode, makeLocation(16, 23));
    assert.isNotNull(valueOfObjectField);

    const comments = analyzer.resolveComments(valueOfObjectField);
    assert.isNotNull(comments);
    assert.equal(comments, " A comment for `testField9`.");
  });

  it("Ignore Hash-style comment before comma", () => {
    // This location points at the `bat` symbol in the expression
    // `fooModule.baz.bat`, where `fooModule` is an imported module.
    // This tests that we can correctly obtain the documentation for
    // a symbol that lies in a multiply-nested index node.
    const valueOfObjectField =
      <ast.LiteralString>resolveSymbolAtPositionFromAst(
        analyzer, ctx, rootNode, makeLocation(17, 23));
    assert.isNotNull(valueOfObjectField);

    const comments = analyzer.resolveComments(valueOfObjectField);
    assert.isNotNull(comments);
    assert.equal(comments, " A comment for `testField10`.");
  });

  it("Ignore CPP-style comments separated by newlines", () => {
    // This location points at the `bat` symbol in the expression
    // `fooModule.baz.bat`, where `fooModule` is an imported module.
    // This tests that we can correctly obtain the documentation for
    // a symbol that lies in a multiply-nested index node.
    const valueOfObjectField =
      <ast.LiteralString>resolveSymbolAtPositionFromAst(
        analyzer, ctx, rootNode, makeLocation(18, 23));
    assert.isNotNull(valueOfObjectField);

    const comments = analyzer.resolveComments(valueOfObjectField);
    assert.isNotNull(comments);
    assert.equal(comments, " A comment for `testField11`.");
  });

  it("Ignore Hash-style comments separated by newlines", () => {
    // This location points at the `bat` symbol in the expression
    // `fooModule.baz.bat`, where `fooModule` is an imported module.
    // This tests that we can correctly obtain the documentation for
    // a symbol that lies in a multiply-nested index node.
    const valueOfObjectField =
      <ast.LiteralString>resolveSymbolAtPositionFromAst(
        analyzer, ctx, rootNode, makeLocation(19, 23));
    assert.isNotNull(valueOfObjectField);

    const comments = analyzer.resolveComments(valueOfObjectField);
    assert.isNotNull(comments);
    assert.equal(comments, " A comment for `testField12`.");
  });
});
