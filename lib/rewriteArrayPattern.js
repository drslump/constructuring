/* jshint esnext:true, eqnull:true */
'strict mode';

var Syntax = require('esprima').Syntax;
var types = require('ast-types');
var n = types.namedTypes;
var b = types.builders;

var createTemporaryVariableDeclaration =
  require('./createTemporaryVariableDeclaration');
var utils = require('./utils');
var p = utils.p, log = utils.log;


// Adds declarations that transfer the values from an identifier on the
// right to the ones on the left ArrayPattern.
// Ex: [a, b] = c --> a = c[0], b = c[1]
function rightSideIdentifier(node, rightIdentifier) {
  var leftElements = node.left.elements;
  for (var i = 0; i < leftElements.length; i++) {
    var leftElement = leftElements[i];
    if (!leftElement) {
      continue;
    }
    var rightElement;
    // When there is an elision (...)
    if (leftElement.type === Syntax.SpreadElement) {
      leftElement = leftElement.argument;
      rightElement = b.callExpression(
        b.memberExpression(
          rightIdentifier,
          b.identifier('slice'),
          false // computed
        ),
        [b.literal(i)]
      );
    } else {
      rightElement = b.memberExpression(
        rightIdentifier,
        b.literal(i),
        true // computed
      );
    }
    node.pushDeclaration(leftElement, rightElement);
  }
  // Variable declarations always evaluate to undefined so we don't need
  // to make it return the 'init' (right) value.
  if (!n.VariableDeclarator.check(this.node)) {
    node.pushDeclaration(rightIdentifier, null);
  }
}

function rightSideCache(node, getId) {
  var cacheVariable = createTemporaryVariableDeclaration.call(
    this,
    getId(),
    node.right,
    node
  );
  rightSideIdentifier.call(this, node, cacheVariable);
}

function rewriteArrayPattern(node, getId) {
  switch (node.right.type) {
    // [a, b] = c
    case Syntax.Identifier:
      rightSideIdentifier.call(this, node, node.right);
      break;
    // [c, d] = [a, b] = [1, 2]
    // case Syntax.AssignmentExpression:
    // [a, b] = `str`
    // case Syntax.TemplateLiteral:
    // [a, b] = i18n`str`
    // case Syntax.TaggedTemplateExpression:
    // [a, b] = class X {}
    // case Syntax.ClassExpression:
    // [a, b] = [x for (x of [1,2])]
    // case Syntax.ComprehensionExpression:
    // [a, b] = () => 1
    // case Syntax.ArrowFunctionExpression:
    // [a, b] = -c
    // case Syntax.UnaryExpression:
    // [a, b] = c++
    // case Syntax.UpdateExpression:
    // [a, b] = c ? d : e
    // case Syntax.ConditionalExpression:
    // [a, b] = this
    // case Syntax.ThisExpression:
    // [a, b] = 0 && 1
    // case Syntax.LogicalExpression:
    // [a, b] = c === d
    // case Syntax.BinaryExpression:
    // [a, b] = new Contructor()
    // case Syntax.NewExpression:
    // [a, b] = yield c
    // case Syntax.YieldExpression:
    // [a, b] = c[0]
    // [a, b] = c.prop
    // case Syntax.MemberExpression:
    // [a, b] = c()
    // case Syntax.CallExpression:
    // [a, b] = 1
    // case Syntax.Literal:
    // [a, b] = (a = 4)
    // case Syntax.SequenceExpression:
    // [a, b] = [b, a]
    // case Syntax.ArrayExpression:
    default:
      rightSideCache.call(this, node, getId);
      break;
  }
}

module.exports = rewriteArrayPattern;
