'use strict';
'require baseclass';
'require view.singbox-dash.v70.lib.schema-model as schemaModel';
'require view.singbox-dash.v70.lib.schema-editor as schemaEditor';

return baseclass.extend({
    clone: schemaModel.clone,
    humanize: schemaModel.humanize,
    resolveSchema: schemaModel.resolveSchema,
    schemaKind: schemaModel.schemaKind,
    objectVariants: schemaModel.objectVariants,
    variantType: schemaModel.variantType,
    variantLabel: schemaModel.variantLabel,
    defaultObject: schemaModel.defaultObject,
    getPath: schemaModel.getPath,
    setPath: schemaModel.setPath,
    fieldLabel: schemaModel.fieldLabel,
    renderMixedUnion: schemaEditor.renderMixedUnion,
    renderJsonEditor: schemaEditor.renderJsonEditor,
    renderMixedArray: schemaEditor.renderMixedArray,
    renderArrayEditor: schemaEditor.renderArrayEditor,
    renderSwitch: schemaEditor.renderSwitch,
    renderEnum: schemaEditor.renderEnum,
    renderTextInput: schemaEditor.renderTextInput,
    renderNumber: schemaEditor.renderNumber,
    renderPrimitiveArray: schemaEditor.renderPrimitiveArray,
    renderFieldRow: schemaEditor.renderFieldRow,
    renderMapEditor: schemaEditor.renderMapEditor,
    renderObjectField: schemaEditor.renderObjectField,
    renderObjectFields: schemaEditor.renderObjectFields,
    renderVariantObject: schemaEditor.renderVariantObject,
    renderObjectArray: schemaEditor.renderObjectArray,
    renderField: schemaEditor.renderField,
    renderTopLevel: schemaEditor.renderTopLevel
});
