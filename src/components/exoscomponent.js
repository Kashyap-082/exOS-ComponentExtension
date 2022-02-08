/*
 * Copyright (C) 2021 B&R Danmark
 * All rights reserved
 * 
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

const { ExosPkg, ExosPkgParseFileResults } = require('../exospkg');
const { ExosPackage, IECProgram, LinuxPackage, CLibrary, UpdatePackageResults, FileObj} = require('../exospackage');
const { TemplateLinuxBuild } = require('./templates/linux/template_linux_build');
const { Datamodel } = require('../datamodel');

const path = require('path')
const fs = require('fs')

const EXOS_COMPONENT_VERSION = "2.0.1"

class Component {

    /**
     * name of the {@link ExosPackage} 
     * @type {string}
    */
    _name;

    /**
     * {@link ExosPackage} created with the name `{name}` 
     * @type {ExosPackage}
    */
    _exospackage;

    constructor(name) {
        this._name = name;
        this._exospackage = new ExosPackage(name);
    }

    makeComponent(location)
    {
        this._exospackage.makePackage(location);
    }
}
/**
 * @typedef {Object} UpdateComponentResults
 * @property {UpdatePackageResults} updateResults results from {@linkcode ExosPackage.updatePackage} if the `parseResults` were without errors
 * @property {ExosPkgParseFileResults} parseResults results from the initial {@linkcode ExosPkg.parseFile} with additions in `componentErrors` from creating the components 
 */
class ComponentUpdate {

    /**
     * path to the {@link ExosPkg}
     */
    _exospkgFileName;

    /**
     * results from parsing the .exospkg file given in the constructor
     * @type {ExosPkgParseFileResults}
     */
    _exosPkgParseResults;

    /**
     * name of the {@link ExosPackage}, derived from the {@linkcode _exospkgFileName}
     * 
     * for example `MyPackage` for `C:\Temp\MyPackage\SomePackage.exospkg`
     * 
     * @type {string}
    */
    _name;

    /**
     * location of the {@link ExosPackage}, derived from the {@linkcode _exospkgFileName}
     * used for the {@linkcode ExosPackage.updatePackage}
     * 
     * for example `C:\Temp` for `C:\Temp\MyPackage\SomePackage.exospkg`
     * 
     * @type {string}
     */
    _location;

    /**
     * {@link ExosPackage} created with the name `{name}` 
     * @type {ExosPackage}
    */
    _exospackage;

    /**
     * Creates an ExosPackage (stored in {@linkcode _exospackage}), and populates its `_exospackage.exospkg` using the given path to the .exospkg file
     * 
     * @param {string} exospkgFileName absolute path to the .exospkg file stored on disk
     */
    constructor(exospkgFileName) {
        //this should be the name of the ExosPackage, the folder in which the .exospkgfile is located
        this._name = path.basename(path.dirname(exospkgFileName));
        this._location = path.dirname(path.dirname(exospkgFileName));

        this._exospkgFileName = exospkgFileName;
        this._exospackage = new ExosPackage(this._name);

        this._exosPkgParseResults = this._exospackage.exospkg.parseFile(exospkgFileName);
    }

    /**
     * Update all created **files** with new content
     * 
     * check the parseResults for any errors - if there are errors here, the files were not created
     * 
     * @example
     * let component = new ExosComponentCUpdate(exosPkgFile);
     * let results = component.updateComponent();
     * 
     * if(results.parseResults.componentFound == true && results.parseResults.componentErrors.length == 0) {
     *      //here we at leaast tried to update the component
     *      //now we can check:
     *      results.updateResults.filesUpdated;
     *      results.updateResults.filesNotFound;
     *      results.updateResults.foldersNotFound;
     * }
     * else {
     *      //something went wrong creating the update object - iterate over the component error list
     *      for(let error of results.parseResults.componentErrors) { 
     *          ..
     *      }
     * }
     * 
     * @param {boolean} createFiles create files if they do not yet exist (dont create folders)
     * 
     * @returns {UpdateComponentResults} information refagarding the update
     */
    updateComponent(createFiles) {
        this._exospackage.exospkg.addGeneratorOption("ComponentUpdate",EXOS_COMPONENT_VERSION);

        if(this._exosPkgParseResults.componentFound == true && this._exosPkgParseResults.componentErrors.length == 0) {
            return {parseResults:this._exosPkgParseResults, updateResults: this._exospackage.updatePackage(this._location, createFiles)};
        }
        else {
            return {parseResults:this._exosPkgParseResults, updateResults: {filesNotFound:0, filesUpdated:0, foldersNotFound:0}};
        }
        
    }
}


/**
 * Base class for (most) ExosComponent Templates
 * 
 */
class ExosComponent extends Component {

    /**
     * name of the IEC datatype used to generate the datamodel, {@link _name} is also set to this {@link _typeName}
     * @type {string}
    */
    _typeName;

   /**
     * The new name of the IEC datatype file used to generate the datamodel, the name is (possibly) changed to reflect the name of the main datatype (the datamodel)
     * @type {string}
    */
    _typeFileName;


    /**
     * name of the .typ source file for generating the datamodel 
     * @type {string}
    */
    _fileName;

    /**
     * generated datamodel using {@link _typeName} and `{typeName}.h` as SGInclude 
     * @type {Datamodel}
    */
    _datamodel;

    /**
     * {@link CLibrary} for AR created in the folder `{typeName}`. by default, the package only contains generated headerfiles
     * @type {CLibrary}
    */
    _cLibrary;

    /**
     * {@link IECProgram} for AR created in the folder `{typeName}_0`. by default, the package does not contain any files
     * @type {IECProgram}
    */
    _iecProgram;

    /**
     * {@link LinuxPackage} created in the folder `Linux`. by default, the package only contains generated headerfiles
     * @type {LinuxPackage}
    */
     _linuxPackage;

    /**
     * {@link TemplateLinuxBuild} for creating CMake and build script, not yet added to the _linuxPackage
      * @type {TemplateLinuxBuild}
      */
    _templateBuild;

    /**
     * List of SG4 includes for the datamodel
     * @type {string[]}
     */
    _SG4Includes;

    /**
     * `buildCommand` which is used for all the `this.linuxPackage.addBuildFile` commands
     * @type {object}
     */
    _linuxBuild;

    /**
     * git ignore the component
     * @type {FileObj}
     */
     _gitIgnore;

    /**
     * git attributes the component
     * @type {FileObj}
     */
    _gitAttributes;

    /**
     * Creates an exOS package from the given `fileName/typeName` and generates headerfiles in the AR Library and the Linux Pacakge
     * It also generates a Linux WSL build command, with headerfiles added as build dependecies
     * 
     * Following objects should be used in inherited classes
     * - {@linkcode _datamodel} datamodel for the `fileName/typeName` with an _SG4 include being the AR Library
     * - {@linkcode _cLibrary} C/C++ library for AR with the name of the datatype (typeName)
     * - {@linkcode _iecProgram} IEC program that uses the Library
     * - {@linkcode _linuxPackage} Linux package
     * 
     * @param {string} fileName 
     * @param {string} typeName  
     */
    constructor(fileName, typeName) {

        super(typeName);

        this._typeName = typeName;
        this._fileName = fileName;
        this._typeFileName = `${typeName}.typ`;

        
        this._SG4Includes = [`${typeName.substr(0,10)}.h`];

        this._datamodel = new Datamodel(fileName, typeName, this._SG4Includes);
        
        this._typFile = {name:this._typeFileName, contents:fs.readFileSync(fileName).toString(), description:`${typeName} datamodel declaration`}

        this._iecProgram = this._exospackage.getNewIECProgram(`${typeName.substr(0,10)}_0`,`${typeName} application`);

        this._cLibrary = this._exospackage.getNewCLibrary(typeName.substr(0,10), `${typeName} exOS library`);
        this._cLibrary.addNewFileObj(this._typFile);
        this._cLibrary.addNewFileObj(this._datamodel.headerFile);
        this._cLibrary.addNewFileObj(this._datamodel.sourceFile);

        this._exospackage.exospkg.addGenerateDatamodel(path.join(this._cLibrary._folderName,this._typeFileName), typeName, this._SG4Includes, [typeName.substr(0,10), "Linux"]);


        this._templateBuild = new TemplateLinuxBuild(typeName);  
        this._linuxBuild = this._exospackage.exospkg.getNewWSLBuildCommand("Linux", this._templateBuild.buildScript.name);

        this._linuxPackage = this._exospackage.getNewLinuxPackage("Linux",`${typeName} Linux resources`);
        this._linuxPackage.addNewBuildFileObj(this._linuxBuild, this._datamodel.headerFile);
        this._linuxPackage.addNewBuildFileObj(this._linuxBuild, this._datamodel.sourceFile);

        this._gitIgnore = this._exospackage.getNewHiddenFile(".gitignore");
        this._gitIgnore.contents = `build/\n`;
        this._gitIgnore.contents += `*.bak\n`;
        this._gitIgnore.contents += `*.ori\n`;

        this._gitAttributes = this._exospackage.getNewHiddenFile(".gitattributes");
        this._gitAttributes.contents = `# Autodetect text files and set to crlf\n`;
        this._gitAttributes.contents += `* text=auto eol=crlf\n`;
        this._gitAttributes.contents += `\n`;
        this._gitAttributes.contents += `# ...Unless the name matches the following overriding patterns\n`;
        this._gitAttributes.contents += `*.sh text eol=lf\n`;
        this._gitAttributes.contents += `Linux/* text eol=lf\n`;
        if(this._templateBuild.options.debPackage.enable == true) {
            this._gitIgnore.contents += "exos-comp-*.deb\n";
        }
    }

    makeComponent(location)
    {
        this._exospackage.exospkg.addGeneratorOption("typeName",this._typeName);
        this._exospackage.exospkg.addGeneratorOption("typeFile",path.join(this._cLibrary._folderName,this._typeFileName));
        this._exospackage.exospkg.addGeneratorOption("SG4Includes",this._SG4Includes.join(","));
        super.makeComponent(location);
    }
}


class ExosComponentUpdate extends ComponentUpdate {

    /**
     * name of the IEC datatype used to generate the datamodel, {@link _name} is also set to this {@link _typeName}
     * @type {string}
    */
     _typeName;

     /**
      * name of the .typ source file for generating the datamodel 
      * @type {string}
     */
     _fileName;
 
     /**
     * List of SG4 includes for the datamodel
     * @type {string[]}
     */
    _SG4Includes;

     /**
      * generated datamodel using {@link _typeName} and `{typeName}.h` as SGInclude 
      * @type {Datamodel}
     */
     _datamodel;
 
     /**
      * {@link CLibrary} for AR created in the folder `{typeName}`. by default, the package only contains generated headerfiles
      * @type {CLibrary}
     */
     _cLibrary;
 
     /**
      * {@link IECProgram} for AR created in the folder `{typeName}_0`. by default, the package does not contain any files
      * @type {IECProgram}
     */
     _iecProgram;
 
     /**
      * {@link LinuxPackage} created in the folder `Linux`. by default, the package only contains generated headerfiles
      * @type {LinuxPackage}
     */
    _linuxPackage;

    /**
     * Creates an exOS package ready for updates with a populated datamodel and 
     * 
     * @param {string} exospkgFileName absolute path to the .exospkg file stored on disk
     */
    constructor(exospkgFileName) { 
        super(exospkgFileName);

        //ok now we created the _exospackage. check the parse results and only create libraries if parsing went well
        if(this._exosPkgParseResults.fileParsed == true && this._exosPkgParseResults.parseErrors == 0 && this._exosPkgParseResults.componentFound == true) {

            if(this._exospackage.exospkg.componentOptions.typeName) {
                this._typeName = this._exospackage.exospkg.componentOptions.typeName;
            }
            else {
                this._exosPkgParseResults.componentErrors.push("ExosComponentUpdate: missing option: typeName");
            }

            if(this._exospackage.exospkg.componentOptions.typeFile) {
                this._fileName = path.join(path.dirname(this._exospkgFileName),this._exospackage.exospkg.componentOptions.typeFile);
            }
            else {
                this._exosPkgParseResults.componentErrors.push("ExosComponentUpdate: missing option: typeFile");
            }
            if(this._exospackage.exospkg.componentOptions.SG4Includes) {
                this._SG4Includes = this._exospackage.exospkg.componentOptions.SG4Includes.split(",");
            }
            else {
                this._exosPkgParseResults.componentErrors.push("ExosComponentUpdate: missing option: SG4Include");
            }

            if(this._exosPkgParseResults.componentErrors.length == 0) {
                //ok everything went well, create the objects

                this._datamodel = new Datamodel(this._fileName,this._typeName, this._SG4Includes);
                this._iecProgram = this._exospackage.getNewIECProgram(`${this._typeName.substr(0,10)}_0`,`${this._typeName} application`);
                this._cLibrary = this._exospackage.getNewCLibrary(this._typeName.substr(0,10), `${this._typeName} exOS library`);
                this._linuxPackage = this._exospackage.getNewLinuxPackage("Linux",`${this._typeName} Linux resources`);

                this._cLibrary.addNewFileObj(this._datamodel.headerFile);
                this._cLibrary.addNewFileObj(this._datamodel.sourceFile);
                this._linuxPackage.addNewFileObj(this._datamodel.headerFile);
                this._linuxPackage.addNewFileObj(this._datamodel.sourceFile);
            }
        }

    }
}

module.exports = {ExosComponent, ExosComponentUpdate, EXOS_COMPONENT_VERSION};