#!/usr/bin/env node --harmony
/* jshint esnext:true, eqnull:true */
'strict mode';

var esprima = require('esprima');
var escodegen = require('escodegen');
var Syntax = esprima.Syntax;
var types = require('ast-types');
var n = types.namedTypes;
var b = types.builders;

var getIdCreator = require('./lib/getIdCreator');
var DeclarationWrapper = require('./lib/DeclarationWrapper');
var utils = require('./lib/utils');
var p = utils.p, log = utils.log;


function createTemporaryVariableDeclaration(node, id, value) {
  var tempVar;
  var temporaryVariableId = b.identifier(id);
  if (n.VariableDeclarator.check(this.node)) {
    tempVar = b.variableDeclarator(
      temporaryVariableId,
      value
    );
    this.replace(tempVar, this.node);
    // WARN: this can be dangerous and depends on internals from ast-types to
    // work.
    // `this.name` is the position of this node on its parent's children array,
    // it's used on `this.replace` as the initial index that will be replaced.
    this.name++;
  } else {
    var path = this;
    while ((path = path.parentPath)) {
      if (typeof path.name === 'number') {
        var parent = path.parentPath;
        if (parent.name === 'body') {
          var previousNode = parent.value[path.name-1];
          tempVar = b.variableDeclarator(temporaryVariableId, null);
          if (n.VariableDeclaration.check(previousNode)) {
            previousNode.declarations.push(tempVar);
          } else {
            var tempVarDeclaration = b.variableDeclaration('var', [tempVar]);
            parent.value.splice(path.name, 0, tempVarDeclaration);
            // since we added one more element, we have to update this
            // element's index (name) on the parent's array
            path.name++;
          }
          break;
        }
      }
    }
    if (!path) {
      throw new Error('No block body could be found as parent of this node.');
    }
    node.unshiftDeclaration(temporaryVariableId, value);
  }
  return temporaryVariableId;
}

// Adds declarations that transfer the values from an identifier on the
// right to the ones on the left ArrayPattern.
// Ex: [a, b] = c --> a = c[0], b = c[1]
function addTransferDeclarations(node, rightIdentifier) {
  var leftElements = node.left.elements;
  for (var i = 0; i < leftElements.length; i++) {
    var leftElement = leftElements[i];
    if (!leftElement) {
      continue;
    }
    var rightElement = b.memberExpression(
      rightIdentifier,
      b.literal(i),
      true // computed
    );
    node.pushDeclaration(leftElement, rightElement);
  }
}

function rightSideIdentifier(node) {
  addTransferDeclarations(node, node.right);
}

function rightSideCache(node, getId) {
  var cacheVariable = createTemporaryVariableDeclaration.call(
    this,
    node,
    getId(),
    node.right
  );
  addTransferDeclarations(node, cacheVariable);
  // Variable declarations always evaluate to undefined so we don't need
  // to make it return the 'init' (right) value.
  if (!n.VariableDeclarator.check(this.node)) {
    node.pushDeclaration(cacheVariable, null);
  }
}

function rewriteAssigmentNode(getId) {
  var node = new DeclarationWrapper(this);

  if (node.left) {
    if (!node.right) {
      return;
    }

    if (n.ArrayPattern.check(node.left)) {
      switch (node.right.type) {
        // [c, d] = [a, b] = [1, 2];
        case Syntax.AssignmentExpression:
          // TODO this can be 'init' sometimes
          var replacementExpressions =
            rewriteAssigmentNode.call(this.get('right'), getId);
          if (replacementExpressions.length !== 1) {
            throw new Error(
              'Why is the replacemenent array bigger than one?'
            );
          }
          var replacementExpression = replacementExpressions[0];
          if (!n.SequenceExpression.check(replacementExpression)) {
            throw new Error(
              'Something unexpected happened, why isn\'t this a ' +
              'SequenceExpression?'
            );
          }
          node.right = replacementExpression;

        // [a, b] = [b, a];
        case Syntax.ArrayExpression:
        // [a, b] = c[0];
        // [a, b] = c.prop;
        case Syntax.MemberExpression:
        // [a, b] = c();
        case Syntax.CallExpression:
        // [a, b] = 1;
        case Syntax.Literal:
        // [a, b] = (a = 4);
        case Syntax.SequenceExpression:
          rightSideCache.call(this, node, getId);
          break;

        // [a, b] = c;
        case Syntax.Identifier:
          rightSideIdentifier.call(this, node);
          break;
      }

    } else if (n.ObjectPattern.check(node.left)) {

      switch (node.right.type) {
        // Right is an object. Ex: ({a}) = {a: 1};
        case Syntax.ObjectExpression:
          rightSideObjectExpression.call(this, node, getId);
          break;
      }

    }

    if (n.ArrayPattern.check(node.left) || n.ObjectPattern.check(node.left)) {
      // Recursively transforms other assignments.
      // For nested ArrayPatterns for example.
      var newNodes = node.getNodes();
      var replacementNodes = this.replace.apply(this, newNodes);
      replacementNodes.forEach(function(replacementNode) {
        types.traverse(
          replacementNode,
          function() {
            traverse.call(this, getId);
          }
        );
      });
      return newNodes;
    }
  }

}

function traverse(getId) {
  var node = this.node;
  if (
    n.VariableDeclarator.check(node) ||
    n.AssignmentExpression.check(node)
  ) {
    rewriteAssigmentNode.call(this, getId);
  } else if (
    n.FunctionDeclaration.check(node) ||
    n.FunctionExpression.check(node)
  ) {
    rewriteFunctionNode.call(this, node, getId);
  }
}

function transform(ast, options) {
  options = options || {};
  var getId = getIdCreator(options.idPrefix);
  var result = types.traverse(ast, function() {
    traverse.call(this, getId);
  });
  return result;
}

function transformSource(source, transformOptions, codegenOptions) {
  var ast = esprima.parse(source);
  return escodegen.generate(transform(ast, transformOptions), codegenOptions);
}

module.exports = {
  transform: transform,
  transformSource: transformSource
};

function ObjectLookupPropertyWithKey(objectExpression, key) {
  for (var i = 0; i < objectExpression.length; i++) {
    var property = objectExpression[i];
    if (property.key.name === key.name) {
      return property;
    }
  }
}

function rightSideObjectExpression(node, getId) {
  var leftProperties = node.left.properties;
  var rightProperties = node.right.properties;

  for (var i = 0; i < leftProperties.length; i++) {
    var leftProperty = leftProperties[i];
    var rightProperty = ObjectLookupPropertyWithKey(
      rightProperties,
      leftProperty.key
    );
    node.pushDeclaration(leftProperty.key, rightProperty.value);
  }
}

function rewriteFunctionNode(node, getId) {
  var params = node.params;
  for (var i = 0; i < params.length; i++) {
    var param = params[i];
    if (n.ArrayPattern.check(param)) {
      var id = b.identifier(getId());
      params[i] = id;

      // NOTE: is the first element from a function body always the block
      // statement or do we have to look for the first one?
      var firstNode = node.body.body[0];
      var declarations;

      if (n.VariableDeclaration.check(firstNode)) {
        declarations = firstNode.declarations;
      } else {
        var variableDeclaration = b.variableDeclaration('var', []);
        node.body.body.unshift(variableDeclaration);
        declarations = variableDeclaration.declarations;
      }

      var elements = param.elements.map(function(element, i) {
        return {
          'type': Syntax.VariableDeclarator,
          'id': element,
          'init': b.memberExpression(
            id,
            b.literal(i),
            true // computed
          )
        };
      });
      declarations.unshift.apply(declarations, elements);
    }

    types.traverse(
      node.body.body[0],
      function(node) {
        traverse.call(this, node, getId);
      }
    );
  }
}
