/*
 * Copyright (C) 2021 B&R Danmark
 * All rights reserved
 * 
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

const version = "1.1.0";

const fs = require('fs');
const path = require('path');

/**
 * Class to generate a {@link Datamodel} json object from a .typ file and create C-source code for the application
 * 
 * @typedef {Object} DatasetAttribute
 * @property {string} name Name of the structure or structure member. The top structure does not have a "name", and is therefore tagged with `<NAME>`
 * @property {string} nodeId (currently not used)
 * @property {string} dataType name of the structure or enum, like `MyStruct`, or the PLC scalar type, like `BOOL`, `UDINT` and so on
 * @property {string} comment comment that is maked in the .typ file for this member. `PUB` and `SUB` are used for code generation
 * @property {number} arraySize size of the array, otherwise `0`, e.g. if the member is declared as `BOOL[5]` the `arraySize` is `5`, and the dataType is `BOOL`
 * @property {number} stringLength for `STRING` datatypes, that are treated specifically this is the allocated size for a string. e.g. `81` for a `STRING[80]`
 * @property {string} info tag that is used for mapping the datastructure with the json string in the code
 * @property {string} info2 tag that is used for arrays (arraySize > 0) to map the datastructure with the json string in the code
 * 
 * @typedef {Object} Dataset data type information structure 
 * @property {string} name `struct` | `variable` | `enum` | `value` type of dataset, whereas enums contains only values
 * @property {DatasetAttribute} attributes properties of this `struct` / `variable` / `enum`, like `dataType` etc.
 * @property {Dataset[]} children array of `Dataset` members for nested types, like `struct` or `enum`
 * 
 * @typedef {Object} StructDependencies
 * @property {string} name name of the structure
 * @property {string} dependencies list of structures that this structure dependends on
 * 
 * @typedef {Object} GeneratedFileObj object that represents a file generated in memory, which can be used for populating the {@link ExosPackage}. Its the same as the {@linkcode FileObj}, but theres currently no dependency between the two, so keeping them separate for now
 * @property {string} name name of the file
 * @property {string} contents contents of the file
 * @property {string} description description visible in AS
 */
class Datamodel {

    /**
     * The JSON {@link Dataset} object representing the datamodel information of the given datatype {@link typeName}. 
     * 
     * *PREVIOUSLY:* `parseTypFile`
     * 
     * This structure is based on the syntax of the `xml-parser` npm module, and thus it is equivalent to parsing an XML file of the following format:
     * 
     *      <struct name="<NAME>" dataType="MyApplication" comment="" >
     *          <variable name="Enable" dataType="BOOL" comment="PUB" />
     *          <variable name="Counter" dataType="INT" comment="SUB" />
     *          <variable name="Temperature" dataType="REAL" comment="PUB" />
     *          <variable name="Buffer" dataType="USINT" arraySize=10 />      
     *          <struct name="Config" dataType="MyConfig" comment="PUB SUB">
     *              <variable name="MaxPressure" dataType="LREAL" comment="" />
     *              <variable name="SleepTime" dataType="LREAL" comment="" />
     *          </struct>
     *      </struct>
     * 
     * This is equivalent to the IEC declaration:
     *      
     *      TYPE
     *         MyApplication : 	STRUCT 
     *              Enable : BOOL; (*PUB*)
     *              Counter : INT; (*SUB*)
     *              Temperature : REAL; (*PUB*)
     *              Buffer : ARRAY[0..9]OF USINT;
     *              Config : MyConfig; (*PUB SUB*)
     *         END_STRUCT;
     *         MyConfig : 	STRUCT 
     *              MaxPressure : LREAL;
     *              SleepTime : LREAL;
     *         END_STRUCT;
     *      END_TYPE
     * 
     * 
     * @type {Dataset}
     */
    dataset;

    /**
     * Lines from the source .typ file split up in to a string array
     * The lines have been cleaned from semicolon, line endings, and some {REDUND} additional infomration
     * 
     * @type {string[]}
     */
    fileLines;

    /**
     * ASCII string with C-datatype definitions of the datatype {@link typeName} - this is part of the {@link headerFile.contents}
     * 
     * *PREVIOUSLY:* `convertTyp2Struct`
     * 
     * @type {string}
     */
    dataTypeCode;

   /**
     * ASCII string with C-datatype definitions of the datatype {@link typeName} adjusted to SWIG
     * 
     * *PREVIOUSLY:* `convertTyp2Struct(swig)`
     * 
     * @type {string}
     */
    dataTypeCodeSWIG;

    /**
     * the generated source code and preset name of the generated headerfile.
     * 
     * *PREVIOUSLY:* `generateHeader`
     * 
     * @type {GeneratedFileObj} 
     */
    headerFile;

    /**
     * the generated source code and preset name of the generated source code file
     * 
     * *PREVIOUSLY:* `generateHeader`
     * 
     * @type {GeneratedFileObj} 
     */
    sourceFile;

    /**
     * fileName name of the file that has been parsed, e.g. ./SomeFolder/MyApplication.typ
     * 
     * @type {string}
     */
    fileName;

    /**
     * typName name of the data structure, e.g. MyApplication
     * 
     * @type {string} 
     */
    typeName;

    /**
     * list of include directives within the #ifdef _SG4 part. If left out, theres no #ifdef _SG4
     * 
     * It's an optional parameter in the constructor, so this property can be undefined
     * 
     * @type {string[]} 
     */
    SG4Includes;

    //limit constants - generates error of exceeded
    static MAX_ARRAY_NEST = 10;
    static MAX_STRUCT_NEST = 32; // avoid infinite loops with cyclic declared types. Not sure what the AS limit is (There is a limit e.g. Error number: 5868)
    static SORT_STRUCT_MAX = 5000;
    static MAX_IDS = 256;
    static MAX_AREA_NAME_LENGTH = 256;
    static MAX_CONFIG_LENGTH = 60000;

    /**
     * Mostly for debugging reasons - list of structures with their dependencies.
     * 
     * @type {StructDependencies[]}
     */
    sortedStructs;

    /**
     * 
     * @param {string} fileName name of the file to parse, e.g. ./SomeFolder/MyApplication.typ
     * @param {string} typName name of the data structure, e.g. MyApplication
     * @param {string[]} [SG4Includes] list of include directives within the #ifdef _SG4 part. If left out, theres no #ifdef _SG4
     * 
     * PREVIOUSLY generateHeader
     */
    constructor(fileName, typeName, SG4Includes) {
        
        this.fileName = fileName;
        this.typeName = typeName;
        this.SG4Includes = SG4Includes;

        this.dataset = [];
        this.sortedStructs = [];

        if (!fs.existsSync(fileName)) {
            throw(`Datamodel: file does not exist: ${fileName}`);
        }

        //read the file
        this.fileLines = fs.readFileSync(this.fileName).toString();
        //remove stuff we dont want to look at
        this.fileLines = this.fileLines.split("\r").join("");
        this.fileLines = this.fileLines.split(";").join("");
        this.fileLines = this.fileLines.split("{REDUND_UNREPLICABLE}").join("");
        //now split with line endings
        this.fileLines = this.fileLines.split("\n");

        this.headerFile = {name:"", contents:"", description:""};
        this.sourceFile = {name:"", contents:"", description:""};

        //create the objects that the class exposes
        //the sequence of the calls cannot be changed
        this.dataset = this._makeJsonTypes(this.fileName);
        this.sourceFile.contents = this._makeSource();
        this.dataTypeCode = this._makeDataTypes();
        this.dataTypeCodeSWIG = this._makeDataTypes(true);
        this.headerFile.contents = this._makeHeader();
        this.headerFile.name = `exos_${this.typeName.toLowerCase()}.h`;
        this.headerFile.description = `Generated datamodel header for ${this.typeName}`;
        this.sourceFile.name = `exos_${this.typeName.toLowerCase()}.c`;
        this.sourceFile.description = `Generated datamodel source for ${this.typeName}`;
    }

    /**
     * @returns {string} datatype (BOOL, UDINT) as stdint.h/stdbool.h datatype (bool, uint32_t) or struct/enum (unchanged)
     * @param {string} type IEC type, like BOOL or UDINT 
     */
     static convertPlcType(type) {
        switch (type) {
            case "BOOL": return "bool";
            case "USINT": return "uint8_t";
            case "SINT": return "int8_t";
            case "UINT": return "uint16_t";
            case "INT": return "int16_t";
            case "UDINT": return "uint32_t";
            case "DINT": return "int32_t";
            case "REAL": return "float";
            case "LREAL": return "double";
            case "BYTE": return "int8_t";
            case "STRING": return "char";
            default: //returning the type makes the function valid even if you insert a struct or enum
                return type;
        }
    }

    /**
     * @returns {boolean} true if the type is scalar (BOOL, UDINT..) or enum. False if it is a structure
     * @param {ApplicationTemplateDataset} dataset where .dataType is IEC type, like BOOL or UDINT 
     * @param {boolean} includeString set whether string should be considered a scalar. Optional and false if not provided
     */
    static isScalarType(dataset, includeString) {
        if(dataset.type == "enum")
            return true;
        switch (dataset.dataType) {
            case "BOOL":
            case "USINT":
            case "SINT":
            case "UINT":
            case "INT":
            case "UDINT":
            case "DINT":
            case "REAL":
            case "LREAL":
            case "BYTE":
            case "STRING":
                if (dataset.dataType === "STRING") {
                    if ((includeString === undefined) || (includeString === false)) { return false; }
                    if ((includeString === true)) { return true; }
                    return false;
                }
                return true;
            default:
                return false;
        }
    }

    /**
     * @returns {string} the printf format string for the given IEC type, like %u for UDINT or %s for STRING
     * 
     * @param {ApplicationTemplateDataset} dataset where .dataType is IEC type, like BOOL or UDINT  
     */
    static convertPlcTypePrintf(dataset) {
        if(dataset.type == "enum")
            return "%i";
        switch (dataset.dataType) {
            case "BOOL": return "%i";
            case "USINT": return "%u";
            case "SINT": return "%i";
            case "UINT": return "%u";
            case "INT": return "%i";
            case "UDINT": return "%u";
            case "DINT": return "%i";
            case "REAL": return "%f";
            case "LREAL": return "%f";
            case "BYTE": return "%i";
            case "STRING": return "%s";
            default: // inserting a struct will give you the address in hex
                return "0x%.8x";
        }
    }

/** KSP
     * Searches for .typ files in project path
     * 
     * @typedef getTypeFileList
     * 
     * @param {string} fileName name of the typ file on the disk 
     * @returns {files[]} list of files haing .typ extension in project path
     */

    static getTypeFileList(fileName) {      

        let getFilesRecursively = (directory) => {
          
            let filesInDirectory = fs.readdirSync(directory);

            for (let file of filesInDirectory) {
                let absolute = path.join(directory, file);
                if (fs.statSync(absolute).isDirectory()) {
                    getFilesRecursively(absolute);
                } 
                else {
                    if ((path.extname(absolute) == ".typ") && (absolute != fileName)) {
                        files.push(absolute);
                    }
                }
            }
        }

        let files = [];
        let dir = path.dirname(fileName).toString();
        if (dir.includes("Logical")) {
            let pos = dir.lastIndexOf("Logical") + "Logical".length;
            let directory = dir.slice(0, pos);    
            getFilesRecursively(directory);
        }

        return(files);
    }		 

    /**
     * Reads a typ file and searches for any structures containing members with PUB or SUB comments
     * The structures that match this criteria are put on top of the array which is returned
     * 
     * @typedef DatatypeListItem
     * @property {string} name name of the structure
     * @property {string[]} members string array of the members within this structures that contain PUB or SUB comment
     * 
     * @param {string} fileName name of the typ file on the disk 
     * @returns {DatatypeListItem[]} al list of all structures in the typ file, with the structures containing PUB SUB comments first
     */
    static getDatatypeList(fileName) {

        let fileLines = Datamodel._splitLines(fs.readFileSync(fileName).toString());

        let searchStruct = false;
        let structs = [];
        let struct = {};
        for (let line of fileLines) {
            if (line.includes("STRUCT") && line.includes(":")) {
                struct = {};
                struct["name"] = line.split(":")[0].trim();
                struct["members"] = [];
                searchStruct = true;
            }
            else if (line.includes("END_STRUCT")) {
                structs.push(struct);                
                searchStruct = false;
            }
            else if(searchStruct)
            {
                let comment = ""
                if (line.includes("(*") && line.includes("*)") && line.includes(":")) {
                    comment = line.split("(*")[1].split("*)")[0];
                    if (comment.includes("PUB") || comment.includes("SUB")) {
                        struct["members"].push(line.split(":")[0].trim());
                    }
                }
            }
        }

        structs.sort((a,b) => {return (b.members.length - a.members.length)});

        return structs;
    }

    static _splitLines(fileLines)
    {
        //remove stuff we dont want to look at
        fileLines = fileLines.split("\r").join("");
        fileLines = fileLines.split(";").join("");
        fileLines = fileLines.split("{REDUND_UNREPLICABLE}").join("");
        //now split with line endings
        fileLines = fileLines.split("\n");
        return fileLines;
    }
    /** 
     * internal function to generate the c-source file that can be accessed via the `Datamodel.sourceCode` property. `_makeJsonTypes()` must have been called prior to this method 
     * @returns {string}
    */
    _makeSource() {

        /**
         * 
         * @param {string} name 
         * @param {StructDependencies[]} sortedStructs 
         */
         function _placeAtEnd(name, sortedStructs) {
            let i = sortedStructs.length;
            while(i--) {
                if(sortedStructs[i].name == name) {
                    sortedStructs.splice(i,1);
                }
            }
            sortedStructs.push({name:name, dependencies:[]});
        }

        let infoId = 0;

        /** adds the .info attributes to all children, containing the <infoId{infoId}> tag and returns the EXOS_DATASET_BROWSE_NAME list for these infoIds*/
        /**
         * 
         * @param {Dataset[]} children 
         * @param {string} parent 
         * @param {string} parentArray 
         * @param {StructDependencies[]} sortedStructs 
         * @returns 
         */
        function _infoChildren(children, parent, parentArray, sortedStructs) {

            let out = "";
        
            if (Array.isArray(children)) {
                for (let child of children) {
        
                    infoId++; // start by increasing to reserve 0 for top level structure
        
                    if (infoId > Datamodel.MAX_IDS) throw (`Too many infoId indexes needed. Max ${Datamodel.MAX_IDS} can be used.`);
        
                    child.attributes.info = "<infoId" + infoId + ">";
        
                    let arrayStr = "";
                    if (child.attributes.arraySize > 0) {
                        if (parentArray != "") {
                            arrayStr = `${parentArray},${child.attributes.arraySize}`;
                        }
                        else {
                            arrayStr = `${child.attributes.arraySize}`;
                        }
                    }
                    else {
                        arrayStr = `${parentArray}`;
                    }
        
                    function checkExosInfoCallParam(call) {
                        let area = call.split("(")[1].split(")")[0].trim();
                        if (area.length > Datamodel.MAX_AREA_NAME_LENGTH) throw (`Area name "${area}" longer than max (${Datamodel.MAX_AREA_NAME_LENGTH})`);
                        return call;
                    }
        
                    if (child.name == "variable" || child.name == "enum") {
                        if(child.name == "enum") {
                            _placeAtEnd(child.attributes.dataType,sortedStructs);
                        }
                        
                        if (parent == "") {
                            if (child.attributes.arraySize > 0) {
                                out += checkExosInfoCallParam(`        {EXOS_DATASET_BROWSE_NAME(${child.attributes.name}),{${parentArray}}},\r\n`);
                                infoId++;
                                child.attributes.info2 = "<infoId" + infoId + ">";
                                out += checkExosInfoCallParam(`        {EXOS_DATASET_BROWSE_NAME(${child.attributes.name}[0]),{${arrayStr}}},\r\n`);
                            }
                            else {
                                out += checkExosInfoCallParam(`        {EXOS_DATASET_BROWSE_NAME(${child.attributes.name}),{${arrayStr}}},\r\n`);
                            }
                        }
                        else {
                            if (child.attributes.arraySize > 0) {
                                out += checkExosInfoCallParam(`        {EXOS_DATASET_BROWSE_NAME(${parent}.${child.attributes.name}),{${parentArray}}},\r\n`);
                                infoId++;
                                child.attributes.info2 = "<infoId" + infoId + ">";
                                out += checkExosInfoCallParam(`        {EXOS_DATASET_BROWSE_NAME(${parent}.${child.attributes.name}[0]),{${arrayStr}}},\r\n`);
                            }
                            else {
                                out += checkExosInfoCallParam(`        {EXOS_DATASET_BROWSE_NAME(${parent}.${child.attributes.name}),{${arrayStr}}},\r\n`);
                            }
                        }
                    }
                    else if (child.name == "struct" && child.hasOwnProperty("children")) {
                        _placeAtEnd(child.attributes.dataType,sortedStructs);

                        if (parent == "") {
                            if (child.attributes.arraySize > 0) {
                                out += checkExosInfoCallParam(`        {EXOS_DATASET_BROWSE_NAME(${child.attributes.name}),{${parentArray}}},\r\n`);
                                infoId++;
                                child.attributes.info2 = "<infoId" + infoId + ">";
                                out += checkExosInfoCallParam(`        {EXOS_DATASET_BROWSE_NAME(${child.attributes.name}[0]),{${arrayStr}}},\r\n`);
                                out += _infoChildren(child.children, `${child.attributes.name}[0]`, arrayStr,sortedStructs);
                            }
                            else {
                                out += checkExosInfoCallParam(`        {EXOS_DATASET_BROWSE_NAME(${child.attributes.name}),{${arrayStr}}},\r\n`);
                                out += _infoChildren(child.children, child.attributes.name, arrayStr, sortedStructs);
                            }
                        }
                        else {
                            if (child.attributes.arraySize > 0) {
        
                                out += checkExosInfoCallParam(`        {EXOS_DATASET_BROWSE_NAME(${parent}.${child.attributes.name}),{${parentArray}}},\r\n`);
                                infoId++;
                                child.attributes.info2 = "<infoId" + infoId + ">";
                                out += checkExosInfoCallParam(`        {EXOS_DATASET_BROWSE_NAME(${parent}.${child.attributes.name}[0]),{${arrayStr}}},\r\n`);
                                out += _infoChildren(child.children, `${parent}.${child.attributes.name}[0]`, arrayStr, sortedStructs);
        
                            }
                            else {
                                out += checkExosInfoCallParam(`        {EXOS_DATASET_BROWSE_NAME(${parent}.${child.attributes.name}),{${arrayStr}}},\r\n`);
                                out += _infoChildren(child.children, `${parent}.${child.attributes.name}`, arrayStr, sortedStructs);
                            }
                        }
                    }
                }
            }
            return out;
        }

        
        /** Replacer function to clean out unecessary thing when stringifying */ 
        function replacer(key, value) {
            if ((key == 'arraySize' && value == 0)
                || (key == 'nodeId' && value == '')
                || (key == 'comment' && value == '')) {
              return undefined; // return undefined so JSON.stringify will omitt it
            }
            if(key == 'comment') {
                //clear all comments that are not purely PUB SUB
                let commentStr = '';
                if(value.includes("PUB")) {
                    commentStr += "PUB";
                }
                if(value.includes("SUB")) {
                    if(commentStr.length > 0) {
                        commentStr += " SUB";
                    }
                    else {
                        commentStr += "SUB";
                    }
                }
                if(commentStr.length > 0)
                    return commentStr;
                else 
                    return undefined;
            }
            return value; // otherwise return the value as it is
        }
        
        _placeAtEnd(this.typeName,this.sortedStructs);

        this.dataset.attributes.info = "<infoId" + infoId + ">"; // top level
        let info = _infoChildren(this.dataset.children, "", "", this.sortedStructs); // needs to be called before JSON.stringify to generate infoId
        let out = "";
        
        this.sortedStructs.reverse();

        let jsonConfig = JSON.stringify(this.dataset, replacer).split('"').join('\\"'); // one liner with escapes on "
        if (jsonConfig.length > Datamodel.MAX_CONFIG_LENGTH) throw (`JSON config (${jsonConfig.length} chars) is longer than maximum (${Datamodel.MAX_CONFIG_LENGTH}).`);
    
        out += `/*Automatically generated c file from ${path.basename(this.fileName)}*/\r\n\r\n`;
        
        out += `#include "exos_${this.typeName.toLowerCase()}.h"\r\n\r\n`;

        out += `const char config_${this.typeName.toLowerCase()}[] = "${jsonConfig}";\r\n\r\n`; 

        out += `/*Connect the ${this.typeName} datamodel to the server*/\r\n`;
        out += `EXOS_ERROR_CODE exos_datamodel_connect_${this.typeName.toLowerCase()}(exos_datamodel_handle_t *datamodel, exos_datamodel_event_cb datamodel_event_callback)\r\n{\r\n`;
        out += `    ${this.typeName} data;\r\n`;
        out += `    exos_dataset_info_t datasets[] = {\r\n`;
        out += `        {EXOS_DATASET_BROWSE_NAME_INIT,{}},\r\n`;
        out += info;
        out = out.slice(0, -3); //remove the last ,\r\n
        out += `\r\n`;
        out += `    };\r\n\r\n`;
    
        out += `    exos_datamodel_calc_dataset_info(datasets, sizeof(datasets));\r\n\r\n`;
    
        out += `    return exos_datamodel_connect(datamodel, config_${this.typeName.toLowerCase()}, datasets, sizeof(datasets), datamodel_event_callback);\r\n`;
        out += `}\r\n`;

        return out;
    }

    /**
     * Internal function to generate the headerfile accessible via the `Datamodel.headerCode`. The `_makeDataTypes()` method must have been called prior to this method. 
     * @returns {string}
     */
    _makeHeader() {
    
        let out = "";
        out = `/*Automatically generated header file from ${path.basename(this.fileName)}*/\r\n\r\n`;
    
        out += `#ifndef _EXOS_COMP_${this.typeName.toUpperCase()}_H_\r\n`;
        out += `#define _EXOS_COMP_${this.typeName.toUpperCase()}_H_\r\n\r\n`;
        out += `#include "exos_api.h"\r\n\r\n`;
    
        if (Array.isArray(this.SG4Includes)) {
            out += `#if defined(_SG4)\r\n`;
            for (let SG4Include of this.SG4Includes) {
                out += `#include <${SG4Include}>\r\n`;
            }
            out += `#else\r\n`;
        }
        out += `#include <stddef.h>\r\n`;
        out += `#include <stdint.h>\r\n`;
        out += `#include <stdbool.h>\r\n\r\n`;
    
        out += this.dataTypeCode;
    
        if (Array.isArray(this.SG4Includes)) {
            out += `#endif // _SG4\r\n\r\n`;
        }
 
        out += `EXOS_ERROR_CODE exos_datamodel_connect_${this.typeName.toLowerCase()}(exos_datamodel_handle_t *datamodel, exos_datamodel_event_cb datamodel_event_callback);\r\n\r\n`;
    
        out += `#endif // _EXOS_COMP_${this.typeName.toUpperCase()}_H_\r\n`
    
        return out;
    }
    
    /**
     * Internal function to generate the C-declaration of the IEC datatype `typeName`, that can be accessible via `Datamodel.dataTypeCode` or `Datamodel.dataTypeCodeSWIG` properties.
     * 
     * @param {boolean} swig create additional swig datatype information
     * @returns {string}
     */
    _makeDataTypes(swig) {
    
        /**return the code for a datatype member with the given properties */
        function _outputMember(type, name, arrays, comment) {
            let out = "";
            out += `    ${type} ${name}`
        
            if (arrays.length > 0) {
                for (let arr of arrays) {
                    if (arr > 0) {
                        out += `[${arr}]`
                    }
                }
            }
            out += `;`
        
            if (comment != "") out += ` //${comment}`;
            out += `\r\n`;
            return out;
        }

        /**search the fileLines to see if name is a structure, returns true if name is a structure*/
        function _isStructType(fileLines, name) {
            for (let line of fileLines) {
                if (line.includes("STRUCT") && line.includes(":")) {
                    if (name == line.split(":")[0].trim()) return true;
                }
            }
            return false;
        }

        /** return the string between two delimiters (start,end) of a given line. return null if one of the delimiters isn't found*/
        function _takeout(line, start, end) {
            if (line.includes(start) && line.includes(end)) {
                return line.split(start)[1].split(end)[0];
            }
            else return null;
        }

        let out = ``;
        let structname = "";
        let members = 0;
        let cmd = "find_struct_enum";
        let structs = [];
        for (let line of this.fileLines) {
            
            let comment = ""
            if (line.includes("(*")) {
                comment = _takeout(line, "(*", "*)");
            }

            switch (cmd) {
                case "find_struct_enum":
                    //analyze row check for struct, enum and directly derived types
    
                    line = line.split("(*")[0];
                    line = line.split(":");
                    for (let i = 0; i < line.length; i++) line[i] = line[i].trim();
    
                    if (line[1] == ("STRUCT")) {
                        cmd = "read_struct";
                        if (comment != "") out += "//" + comment + "\r\n";
                        structname = line[0];
                        out += `typedef struct ${structname}\r\n{\r\n`;
                        structs.push({ name: structname, out: "", depends: [] });
                    }
                    else if (line[1] == ("")) {
                        cmd = "read_enum";
                        if (comment != "") out += "//" + comment + "\r\n";
                        structname = line[0];
                        out += `typedef enum ${structname}\r\n{\r\n`;
                        members = 0;
                        structs.push({ name: structname, out: "", depends: [] });
                    }
                    //"else" line[1] is not "" (enum) and not "STRUCT" then it have to be a derived type = do nothing
                    break;
    
                case "read_enum":
                    if (line.includes(")")) {
                        cmd = "find_struct_enum";
                        if (members > 0) {
                            out = out.slice(0, -3); //remove the last ,\r\n
                            out += `\r\n`;
                        }
                        out += `\r\n} ${structname};\r\n\r\n`;
                        structs[structs.length - 1].out = out;
                        out = "";
                    }
                    else if (!line.includes("(")) {
                        if (line.includes(":=")) {
                            let name = line.split(":=")[0].trim();
                            let enumValue = line.split(":=")[1].trim();
                            enumValue = parseInt(enumValue.split(",")[0].trim());
                            out += `    ${name} = ${enumValue},\r\n`;
                        }
                        else {
                            let name = line.split(",")[0].trim();
                            out += `    ${name},\r\n`;
                        }
                        members++;
                    }
                    break;
    
                case "read_struct":
                    if (line.includes("END_STRUCT")) {
                        cmd = "find_struct_enum";
                        out += `\r\n} ${structname};\r\n\r\n`;
                        structs[structs.length - 1].out = out;
                        out = "";
                    }
                    else {
                        let arraySize = 0;
                        let stringSize = 0;
                        if (line.includes("ARRAY")) {
                            let range = _takeout(line, "[", "]")
                            if (range != null) {
                                let from = parseInt(range.split("..")[0].trim());
                                let to = parseInt(range.split("..")[1].trim());
                                arraySize = to - from + 1;
                            }
                        }
                        if (line.includes(":")) {
                            let name = line.split(":")[0].trim();
                            let type = "";
                            if (arraySize > 0) {
                                type = line.split(":")[1].split("OF")[1].trim();
                            }
                            else {
                                type = line.split(":")[1].trim();
                            }
                            //let comment = "";
                            if (type.includes("(*")) {
                                //comment = _takeout(type, "(*", "*)");
                                type = type.split("(*")[0].trim();
                            }
    
                            if (arraySize > 0 && swig !== undefined && swig) {
                                out += `    // array not exposed directly:`
                            }
    
                            let typeForSwig = "";
                            let dataset = {dataType: type, type: "notenum"};
                            if (type.includes("STRING")) {
                                let length = _takeout(type, "[", "]");
                                if (length != null) {
                                    typeForSwig = "char";
                                    stringSize = parseInt(length) + 1;
                                    out += _outputMember("char", name, [arraySize, stringSize], comment);
                                }
                            }
                            else if (Datamodel.isScalarType(dataset)) {
                                let stdtype = Datamodel.convertPlcType(type);
                                typeForSwig = stdtype;
                                out += _outputMember(stdtype, name, [arraySize], comment);
                            }
                            else {
                                structs[structs.length - 1].depends.push(type); // push before adding "struct "
                                typeForSwig = type;
                                if (_isStructType(this.fileLines, type)) {
                                    typeForSwig = type;
                                    type = "struct " + type;
                                }
                                out += _outputMember(type, name, [arraySize], comment);
                            }
    
                            if (arraySize > 0 && swig !== undefined && swig) {
                                // add sai=swig array info
                                out += `<sai>{"structname": "${structname}", "membername": "${name}", "datatype": "${typeForSwig}", "arraysize": "${arraySize}", "stringsize": "${stringSize}"}</sai>`
                            }
                        }
                    }
                    break;
            }
        }
    

        //output the sorted structures
        out = "";

        for(let i=0; i<this.sortedStructs.length; i++) {
            for (let struct of structs) {
                if(this.sortedStructs[i].name ==struct.name) {
                    this.sortedStructs[i].dependencies = struct.depends;

                    // find and extract all swig array info stuff and add them last to be able to replace it correctly in swig template generator
                    if (swig !== undefined && swig) {
                        // do not include the last one (top-level struct) as it already exists as struct lib<typname>
                        if(i < this.sortedStructs.length-1) {
                            let swigInfo = ""
                            let matches = struct.out.matchAll(/<sai>(.*)<\/sai>/g);
                            let swigInfoResult = Array.from(matches, x => x[1]);
                            if (swigInfoResult.length > 0)
                                swigInfo = `<sai>{"swiginfo": [` + swigInfoResult.join(",") + `]}</sai>`;
                            out += struct.out.replace(/<sai>.*<\/sai>/g, "") + swigInfo;
                        }
                    }
                    else {
                        out += struct.out;
                    } 
                }
            }
        }

        return out;
    }

    /**
     * Internal function which parses the IEC datatype `typeName` and generates a JSON structure for further usage.
     * @returns {object} JSON object representation of the datatype `typeName` structure
     */
    _makeJsonTypes(fileName) {
 
        let nestingDepth = 0;
        let structNestingDepth = 0;

        /**
         * return a json object with members of the given structure (name, type) going through fileLines including comment and arraysize of this structure
         * the search continues until scalar types or enumerators are found. nestingDepth and structuNEstingDepth are control variables to make sure it
         * doesnt go too far (e.g. circular dependencies)
        */
        function _parseTyp(fileLines, name, type, comment, arraySize) {

            function _addSuffixInTypMember(fileLines, typName) {
                let i = 0;
                let typ = typName.toString();
                for(let line of fileLines) {
                    if (line.includes(typ)) {
                        let l = line.split(":")[1].split("(*")[0].trim();
                        if (l == typ) {
                            let newTyp = typ.concat("_exos");
                            fileLines[i] = fileLines[i].replace(typName, newTyp);   
                        }
                    }
                    i++;
                }
                return 0;          
            }

            function _writeExtDataIntoSrcFile(srcFileData, extFileData, typName) {

                let TypStr = typName.toString();
                let index = extFileData.indexOf(TypStr);
                let str = extFileData.slice(index).split(":")[0].trim();
                // Remove unnecessary data up to start of data type
                while (str != TypStr) {
                    extFileData = extFileData.slice((index + TypStr.length));
                    index = extFileData.indexOf(TypStr);
                    str = extFileData.slice(index).split(":")[0].trim();
                }
                extFileData = extFileData.slice((index + TypStr.length));
                


                // Find End point of external data type 
                index = extFileData.indexOf("END_STRUCT") + "END_STRUCT".length;
                // Remove unnecessary data after ending of data type
                extFileData = extFileData.slice(0, index);

                // Add suffix in data type name
                TypStr = TypStr.concat("_exos");
                // Prepare data in proper format
                TypStr = "\t".concat(TypStr);
                extFileData = TypStr.concat(extFileData);
                extFileData = extFileData.concat(";\r\nEND_TYPE\r\n"); 
                
                // Add suffix in type member name in source data
                TypStr = typName.toString();
                let newTypStr = TypStr.concat("_exos");
                let re = new RegExp(TypStr, 'g');
                srcFileData = srcFileData.replace(re, newTypStr);

                // Search end of file END_TYPE
                index = srcFileData.indexOf("END_TYPE");
                srcFileData = srcFileData.slice(0, index);

                // Merge external type data in to original source data
                srcFileData = srcFileData.concat(extFileData);

                return srcFileData;
            }

            function _findExtTyp(fileLines, typName) {
                let extTypFiles = Datamodel.getTypeFileList(fileName);  
                let structFound = false;
                let extStructLine = -1;
                let extLines = [];
                for (let extTypFile of extTypFiles) {
                    // Read data of each file and convert it to string
                    let extFileData = fs.readFileSync(extTypFile).toString();
                    let extFileLines = Datamodel._splitLines(extFileData);             //Split string data in to lines
                    
                    for (let extFileline of extFileLines) {
                        //trim down to match the type name EXACTLY to specified name, 
                        //includes() is also true for "myStruct" == "myStructSomething"
                        let l = extFileline.split(":")[0].trim();
                        //Find start point of structure
                        if ((l == typName) && (extFileline.includes("STRUCT"))) {
                            structFound = true;
                            // Add suffix _exos in all type member
                            _addSuffixInTypMember(fileLines, typName);
                            // Add lines to external line array 
                            l = l.concat("_exos");
                            extLines.push(extFileline.replace(typName, l));
                        }
                        else if ((extFileline.includes("END_STRUCT")) && structFound) {
                            // Add lines to external line array
                            extLines.push(extFileline);
                            // Remove blank space ('') at the end of fileLines
                            fileLines.pop();
                            // Recoed start Line at which external structure will be added
                            extStructLine = fileLines.length; 
                            // Remove END_TYP from fileLines
                            fileLines.pop();
                            // Push all external structure lines in to main fileLine array
                            for (let extline of extLines) {
                                fileLines.push(extline);
                            }
                            // Push end of type file END_TYPE
                            fileLines.push("END_TYPE");
                            fileLines.push("");

                            // Read source .typ file
                            let srcFileData = fs.readFileSync(fileName).toString();
                            // Write Modified data in .typ file
                            fs.writeFileSync(fileName, _writeExtDataIntoSrcFile(srcFileData, extFileData, typName));
                            return extStructLine;
                        }
                        else if (structFound) {
                            extLines.push(extFileline);            
                        }
    
                    }
                }
                return -1;    
            }
            /**find a structure (typName) within the fileLines[] and return the line index. return -1 if not found*/
            function _findStructTyp(fileLines, typName) {
                let i = 0;
                for (let line of fileLines) {
                    //trim down to match the type name EXACTLY to specified name, includes() is also true for "myStruct" == "myStructSomething"
                    let l = line.split(":")[0].trim();
                    if ((l == typName) && (line.includes("STRUCT"))) {
                        return i;
                    }
                    i++;
                }

                let result = _findExtTyp(fileLines, typName);
                if (result >= 0) {
                    return result;
                }
                return -1;
            }

            /**find an enum (typName) within fileLines and return the line index. return -1 if not found */
            function _findEnumTyp(fileLines, typName) {
                let i = 0;
                for (let line of fileLines) {
                    //trim down to match the type name EXACTLY to specified name, includes() is also true for "myStruct" == "myStructSomething"
                    let l = line.split(":");
                    if(l.length > 1)
                    {
                        if ((l[0].trim() == typName) && (l[1].trim() == "") && (!line.includes("STRUCT"))) {
                            return i;
                        }
                    }
                    i++;
                }
                return -1;
            }

            /**find a directly derived type (typName) within the fileLines[] and return the line index. return -1 if not found*/
            function _findDirectlyDerivedType(fileLines, typName) {
                let i = 0;
                for (let line of fileLines) {
                    //trim down to match the type name EXACTLY to specified name, includes() is also true for "myStruct" == "myStructSomething"
                    let l = line.split(":");
                    if(l.length > 1)
                    {
                        if ((l[0].trim() == typName) && (l[1].trim() != "") && (!line.includes("STRUCT"))) {
                            return i;
                        }
                    }
                    i++;
                }
                return -1;
            }

            /**return a json representation of an enum value at the given fileLines[index] and store its value (if assigned) to enumValue*/
            function _parseEnumMember(fileLines, index, enumValue) {

                let name = "";
                if (fileLines[index].includes("(")) {
                    return null;
                }
                else if (fileLines[index].includes(":=")) {
                    name = fileLines[index].split(":=")[0].trim();
                    enumValue = fileLines[index].split(":=")[1].trim()
                    enumValue = parseInt(enumValue.split(",")[0].trim());
                }
                else {
                    name = fileLines[index].split(",")[0].trim();
                }
            
                return {
                    name: "value",
                    attributes: {
                        name: name,
                        value: enumValue
                    }
                }
            }

            /** return a json object of the member at the given line, returns a 'variable' object for scalar types and calls _parseTyp (recursively) if a structure is found*/
            function _parseStructMember(fileLines, index) {
                
                function _takeout(line, start, end) {
                    if (line.includes(start) && line.includes(end)) {
                        return line.split(start)[1].split(end)[0];
                    }
                    else return null;
                }
                
                function plcTypeNotSupported(type)
                {
                    switch(type)
                    {
                        case "DATE":
                        case "DATE_AND_TIME":
                        case "DT":
                        case "DWORD":
                        case "TIME":
                        case "TIME_OF_DAY":
                        case "TOD":
                        case "WORD":
                        case "WSTRING":
                            return true;
                    }
                    return false;
                }

                let arraySize = 0;
                let dimensions = [0];
            
                if (fileLines[index].includes(":")) {
                    let name = fileLines[index].split(":")[0].trim();
            
                    if (fileLines[index].includes("ARRAY")) {
                        let ranges = _takeout(fileLines[index], "[", "]")
                        dimensions = ranges.split(",");
            
                        if (dimensions.length > 1) {
                            throw (`Multi dimensional arrays are not supported -> member "${name}"`);
                        }
                        if (ranges != null) {
                            let fromStr = ranges.split("..")[0].trim()
                            let toStr = ranges.split("..")[1].trim()

                            if(isNaN(fromStr) || isNaN(toStr)) {
                                throw (`Array with non-numeric bounds not supported -> member "${name}"`);
                            }

                            let from = parseInt(fromStr);
                            let to = parseInt(toStr);

                            if(from != 0) {
                                throw (`Array bound not starting from 0 not supported -> member "${name}"`);
                            } 

                            arraySize = to - from + 1;
                            nestingDepth += dimensions.length; //add a nesting depth for each dimention in multi-dim arrays
                            if (nestingDepth > Datamodel.MAX_ARRAY_NEST) throw (`Member "${name}" has array nesting depth of ${nestingDepth} deeper than ${Datamodel.MAX_ARRAY_NEST} nests`);
                        }
                    }
            
                    let type = "";
                    if (arraySize > 0) {
                        type = fileLines[index].split(":")[1].split("OF")[1].trim();
                    }
                    else {
                        type = fileLines[index].split(":")[1].trim();
                    }
                    if (type.includes("(*")) {
                        type = type.split("(*")[0].trim();
                    }
            
                    let comment = "";
                    if (fileLines[index].includes("(*")) {
                        comment = _takeout(fileLines[index], "(*", "*)");
                    }
            
                    if(type.includes("REFERENCE")) {
                        throw (`Referenced members are not supported -> member "${name}"`);
                    }
                    
                    if(plcTypeNotSupported(type)) {
                        throw (`IEC Type ${type} is not supported -> member "${name}"`);
                    }

                    let dataset = {dataType: type, type: "notenum"};
                    if (type.includes("STRING")) {
                        if (arraySize > 0) nestingDepth -= dimensions.length;
                        let length = _takeout(type, "[", "]");
                        if (length != null) {
                            return {
                                name: "variable",
                                attributes: {
                                    name: name,
                                    nodeId: "",
                                    dataType: "STRING",
                                    stringLength: parseInt(length) + 1,
                                    comment: comment,
                                    arraySize: arraySize
                                }
                            }
                        }
                    }
                    else if (Datamodel.isScalarType(dataset)) {
                        if (arraySize > 0) nestingDepth -= dimensions.length;
                        return {
                            name: "variable",
                            attributes: {
                                name: name,
                                nodeId: "",
                                dataType: type,
                                comment: comment,
                                arraySize: arraySize
                            }
                        }
                    }
                    else {
                        //datatype detected = dig deeper
                        structNestingDepth++;
                        let result = _parseTyp(fileLines, name, type, comment, arraySize);
                        structNestingDepth--;
                        if (arraySize > 0) nestingDepth -= dimensions.length;
                        return result
                    }
                }
                return null;
            }

            let children = [];
            let start;
        
            start = _findStructTyp(fileLines, type);
            //this is a structure
            if (start != -1) {
                let i = 1;
                while (!fileLines[start + i].includes("END_STRUCT")) {
                    if (structNestingDepth > Datamodel.MAX_STRUCT_NEST)
                    {
                        throw (`Member "${name} : ${type}" has struct nesting depth of ${structNestingDepth} which exceeds the maximum of ${Datamodel.MAX_STRUCT_NEST} nests (possible recursion)`);
                    }
                    let member = _parseStructMember(fileLines, start + i);
                    if (member != null) {
                        children.push(member);
                    }
                    i++;
                }
                return {
                    name: "struct",
                    attributes: {
                        name: name,
                        nodeId: "",
                        dataType: type,
                        comment: comment,
                        arraySize: arraySize
                    },
                    children: children
                }
            }
            //this is an enum
            else {
                start = _findEnumTyp(fileLines, type);
                if (start != -1) {
                    let i = 1;
                    let enumValue = 0;
                    while (!fileLines[start + i].includes(")")) {
                        let member = _parseEnumMember(fileLines, start + i, enumValue);
                        if (member != null) {
                            children.push(member);
                            enumValue = member.attributes.value + 1;
                        }
                        i++;
                    }
                    return {
                        name: "enum",
                        attributes: {
                            name: name,
                            nodeId: "",
                            dataType: type,
                            comment: comment,
                            arraySize: 0
                        },
                        children: children
                    }
                } else {
        
                    if (_findDirectlyDerivedType(fileLines, type) >= 0) {
                        //datatype was not found,in .typ file, if not kill with error
                        throw (`Datatype '${type}' is a directly derived type. Not supported!`);
                    } else {
                        //datatype was not found,in .typ file, if not kill with error
                        throw (`Datatype '${type}' not defined in .typ file`);
                    }
                }
            }
        }

        return _parseTyp(this.fileLines, "<NAME>", this.typeName, "", 0);
    }

}



if (require.main === module) {

    process.stdout.write(`exOS Datamodel version ${version}\r\n`);

    if (process.argv.length > 3) {

        let fileName = process.argv[2];
        let structName = process.argv[3];

        if (fs.existsSync(fileName)) {

                let datamodel = new Datamodel(fileName, structName, [`${structName}.h`]);
                let outDir = path.join(__dirname,path.dirname(fileName));

                process.stdout.write(`Writing ${structName} to folder: ${outDir}\r\n`);

                fs.writeFileSync(path.join(outDir,`exos_${structName.toLowerCase()}.h`),datamodel.headerFile.contents);
                fs.writeFileSync(path.join(outDir,`exos_${structName.toLowerCase()}.c`),datamodel.sourceFile.contents);
                fs.writeFileSync(path.join(outDir,`exos_${structName.toLowerCase()}.json`),JSON.stringify(datamodel.dataset,null,4));
                fs.writeFileSync(path.join(outDir,`exos_${structName.toLowerCase()}_swig.c`),datamodel.dataTypeCodeSWIG);

                console.log(datamodel.sortedStructs);

                console.log(Datamodel.getDatatypeList(fileName));

        } else {
            process.stderr.write(`file '${fileName}' not found.`);
        }

    }
    else {
        process.stderr.write("usage: ./Datamodel.js <filename.typ> <structname>\r\n");
    }
}

module.exports = {Datamodel};