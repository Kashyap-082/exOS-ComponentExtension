// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');
const exosheader = require("./exos_header");
const exostemplate = require('./c-template/exos_template');
const exosas = require("./c-template/exos_template_as");
const clibtemplate = require('./c-static-lib-template/template');
const path = require('path');
const fs = require('fs')

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "exos-component-extension" is now active!');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with  registerCommand
	// The commandId parameter must match the command field in package.json
	let generateTemplate = vscode.commands.registerCommand('exos-component-extension.generateTemplate', function (uri) {
		// The code you place here will be executed every time your command is executed

		vscode.window.showInputBox({prompt:"Name of the DataType:"}).then(selection => {
			
			try {
				exostemplate.generateTemplate(uri.fsPath, selection, path.dirname(uri.fsPath));
				vscode.window.showInformationMessage(`Generated Template for ${selection}`);

				if(exosas.replaceTypWithPackage(uri.fsPath, selection)) {
					vscode.window.showInformationMessage(`Replaced ${path.basename(uri.fsPath)} with ${selection} Package. The file ${path.basename(uri.fsPath)} has been copied to the ${selection.substring(0,10)} Library`);
				}
				
			} catch (error) {
				vscode.window.showErrorMessage(error);	
			}

		});


	});
	context.subscriptions.push(generateTemplate);

	let generateCLibTemplate = vscode.commands.registerCommand('exos-component-extension.generateCLibTemplate', function (uri) {
		vscode.window.showInputBox({prompt:"Name of the DataType:"}).then(selection => {
			
			try {
				clibtemplate.generateTemplate(uri.fsPath, selection, path.dirname(uri.fsPath));
				vscode.window.showInformationMessage(`Generated C-Lib Template for ${selection}`);

				// if(exosas.replaceTypWithPackage(uri.fsPath, selection)) {
				// 	vscode.window.showInformationMessage(`Replaced ${path.basename(uri.fsPath)} with ${selection} Package. The file ${path.basename(uri.fsPath)} has been copied to the ${selection.substring(0,10)} Library`);
				// }
				
			} catch (error) {
				vscode.window.showErrorMessage(error);	
			}

		});
	});
	context.subscriptions.push(generateCLibTemplate);

}
exports.activate = activate;

// this method is called when your extension is deactivated
function deactivate() {}

module.exports = {
	activate,
	deactivate
}
