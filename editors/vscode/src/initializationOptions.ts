/**
 * Severity level for diagnostic messages.
 * Maps to LSP DiagnosticSeverity values.
 */
export type SeverityLevel = "error" | "warning" | "information" | "hint" | "off";

/**
 * Subset of VS Code's configuration inspection result used when building
 * initialization options.
 */
export interface RavenConfigurationInspection<T> {
    globalValue?: T;
    workspaceValue?: T;
    workspaceFolderValue?: T;
    globalLanguageValue?: T;
    workspaceLanguageValue?: T;
    workspaceFolderLanguageValue?: T;
}

/**
 * Minimal configuration interface compatible with vscode.WorkspaceConfiguration
 * and the test double used in the settings tests.
 */
export interface RavenWorkspaceConfiguration {
    get<T>(section: string): T | undefined;
    get<T>(section: string, defaultValue: T): T;
    inspect<T>(section: string): RavenConfigurationInspection<T> | undefined;
}

/**
 * Initialization options passed to the Raven LSP server.
 * This interface matches the JSON structure expected by the server's
 * `parse_cross_file_config()` and related parsing functions.
 */
export interface RavenInitializationOptions {
    crossFile?: {
        backwardDependencies?: "auto" | "explicit";
        maxBackwardDepth?: number;
        maxForwardDepth?: number;
        maxChainDepth?: number;
        assumeCallSite?: "start" | "end";
        indexWorkspace?: boolean;
        maxRevalidationsPerTrigger?: number;
        revalidationDebounceMs?: number;
        missingFileSeverity?: SeverityLevel;
        circularDependencySeverity?: SeverityLevel;
        outOfScopeSeverity?: SeverityLevel;
        ambiguousParentSeverity?: SeverityLevel;
        maxChainDepthSeverity?: SeverityLevel;
        redundantDirectiveSeverity?: SeverityLevel;
        onDemandIndexing?: {
            enabled?: boolean;
            maxTransitiveDepth?: number;
            maxQueueSize?: number;
        };
        cache?: {
            metadataMaxEntries?: number;
            fileContentMaxEntries?: number;
            existenceMaxEntries?: number;
            workspaceIndexMaxEntries?: number;
        };
    };
    diagnostics?: {
        enabled?: boolean;
        undefinedVariables?: boolean;
    };
    packages?: {
        enabled?: boolean;
        additionalLibraryPaths?: string[];
        rPath?: string;
        missingPackageSeverity?: SeverityLevel;
    };
    symbols?: {
        workspaceMaxResults?: number;
    };
    completion?: {
        triggerOnOpenParen?: boolean;
    };
    indentation?: {
        style?: "rstudio" | "rstudio-minus" | "off";
    };
}

function isExplicitlyConfigured<T>(config: RavenWorkspaceConfiguration, key: string): boolean {
    const inspection = config.inspect<T>(key);
    if (!inspection) {
        return false;
    }
    return (
        inspection.globalValue !== undefined ||
        inspection.workspaceValue !== undefined ||
        inspection.workspaceFolderValue !== undefined ||
        inspection.globalLanguageValue !== undefined ||
        inspection.workspaceLanguageValue !== undefined ||
        inspection.workspaceFolderLanguageValue !== undefined
    );
}

function getExplicitSetting<T>(config: RavenWorkspaceConfiguration, key: string): T | undefined {
    if (isExplicitlyConfigured<T>(config, key)) {
        return config.get<T>(key);
    }
    return undefined;
}

/**
 * Read Raven settings from the provided configuration object and construct the
 * LSP initialization options payload.
 */
export function getInitializationOptions(config: RavenWorkspaceConfiguration): RavenInitializationOptions {
    const options: RavenInitializationOptions = {};

    const backwardDependencies = getExplicitSetting<"auto" | "explicit">(config, 'crossFile.backwardDependencies');
    const maxBackwardDepth = getExplicitSetting<number>(config, 'crossFile.maxBackwardDepth');
    const maxForwardDepth = getExplicitSetting<number>(config, 'crossFile.maxForwardDepth');
    const maxChainDepth = getExplicitSetting<number>(config, 'crossFile.maxChainDepth');
    const assumeCallSite = getExplicitSetting<"start" | "end">(config, 'crossFile.assumeCallSite');
    const indexWorkspace = getExplicitSetting<boolean>(config, 'crossFile.indexWorkspace');
    const maxRevalidationsPerTrigger = getExplicitSetting<number>(config, 'crossFile.maxRevalidationsPerTrigger');
    const revalidationDebounceMs = getExplicitSetting<number>(config, 'crossFile.revalidationDebounceMs');
    const missingFileSeverity = getExplicitSetting<SeverityLevel>(config, 'crossFile.missingFileSeverity');
    const circularDependencySeverity = getExplicitSetting<SeverityLevel>(config, 'crossFile.circularDependencySeverity');
    const outOfScopeSeverity = getExplicitSetting<SeverityLevel>(config, 'crossFile.outOfScopeSeverity');
    const ambiguousParentSeverity = getExplicitSetting<SeverityLevel>(config, 'crossFile.ambiguousParentSeverity');
    const maxChainDepthSeverity = getExplicitSetting<SeverityLevel>(config, 'crossFile.maxChainDepthSeverity');
    const redundantDirectiveSeverity = getExplicitSetting<SeverityLevel>(config, 'crossFile.redundantDirectiveSeverity');

    const onDemandEnabled = getExplicitSetting<boolean>(config, 'crossFile.onDemandIndexing.enabled');
    const onDemandMaxTransitiveDepth = getExplicitSetting<number>(config, 'crossFile.onDemandIndexing.maxTransitiveDepth');
    const onDemandMaxQueueSize = getExplicitSetting<number>(config, 'crossFile.onDemandIndexing.maxQueueSize');

    let onDemandIndexing: {
        enabled?: boolean;
        maxTransitiveDepth?: number;
        maxQueueSize?: number;
    } | undefined = undefined;
    if (onDemandEnabled !== undefined || onDemandMaxTransitiveDepth !== undefined || onDemandMaxQueueSize !== undefined) {
        onDemandIndexing = {};
        if (onDemandEnabled !== undefined) {
            onDemandIndexing.enabled = onDemandEnabled;
        }
        if (onDemandMaxTransitiveDepth !== undefined) {
            onDemandIndexing.maxTransitiveDepth = onDemandMaxTransitiveDepth;
        }
        if (onDemandMaxQueueSize !== undefined) {
            onDemandIndexing.maxQueueSize = onDemandMaxQueueSize;
        }
    }

    const cacheMetadataMaxEntries = getExplicitSetting<number>(config, 'crossFile.cache.metadataMaxEntries');
    const cacheFileContentMaxEntries = getExplicitSetting<number>(config, 'crossFile.cache.fileContentMaxEntries');
    const cacheExistenceMaxEntries = getExplicitSetting<number>(config, 'crossFile.cache.existenceMaxEntries');
    const cacheWorkspaceIndexMaxEntries = getExplicitSetting<number>(config, 'crossFile.cache.workspaceIndexMaxEntries');

    let cache: {
        metadataMaxEntries?: number;
        fileContentMaxEntries?: number;
        existenceMaxEntries?: number;
        workspaceIndexMaxEntries?: number;
    } | undefined = undefined;
    if (
        cacheMetadataMaxEntries !== undefined ||
        cacheFileContentMaxEntries !== undefined ||
        cacheExistenceMaxEntries !== undefined ||
        cacheWorkspaceIndexMaxEntries !== undefined
    ) {
        cache = {};
        if (cacheMetadataMaxEntries !== undefined) {
            cache.metadataMaxEntries = cacheMetadataMaxEntries;
        }
        if (cacheFileContentMaxEntries !== undefined) {
            cache.fileContentMaxEntries = cacheFileContentMaxEntries;
        }
        if (cacheExistenceMaxEntries !== undefined) {
            cache.existenceMaxEntries = cacheExistenceMaxEntries;
        }
        if (cacheWorkspaceIndexMaxEntries !== undefined) {
            cache.workspaceIndexMaxEntries = cacheWorkspaceIndexMaxEntries;
        }
    }

    if (
        backwardDependencies !== undefined ||
        maxBackwardDepth !== undefined ||
        maxForwardDepth !== undefined ||
        maxChainDepth !== undefined ||
        assumeCallSite !== undefined ||
        indexWorkspace !== undefined ||
        maxRevalidationsPerTrigger !== undefined ||
        revalidationDebounceMs !== undefined ||
        missingFileSeverity !== undefined ||
        circularDependencySeverity !== undefined ||
        outOfScopeSeverity !== undefined ||
        ambiguousParentSeverity !== undefined ||
        maxChainDepthSeverity !== undefined ||
        redundantDirectiveSeverity !== undefined ||
        onDemandIndexing !== undefined ||
        cache !== undefined
    ) {
        options.crossFile = {};
        if (backwardDependencies !== undefined) {
            options.crossFile.backwardDependencies = backwardDependencies;
        }
        if (maxBackwardDepth !== undefined) {
            options.crossFile.maxBackwardDepth = maxBackwardDepth;
        }
        if (maxForwardDepth !== undefined) {
            options.crossFile.maxForwardDepth = maxForwardDepth;
        }
        if (maxChainDepth !== undefined) {
            options.crossFile.maxChainDepth = maxChainDepth;
        }
        if (assumeCallSite !== undefined) {
            options.crossFile.assumeCallSite = assumeCallSite;
        }
        if (indexWorkspace !== undefined) {
            options.crossFile.indexWorkspace = indexWorkspace;
        }
        if (maxRevalidationsPerTrigger !== undefined) {
            options.crossFile.maxRevalidationsPerTrigger = maxRevalidationsPerTrigger;
        }
        if (revalidationDebounceMs !== undefined) {
            options.crossFile.revalidationDebounceMs = revalidationDebounceMs;
        }
        if (missingFileSeverity !== undefined) {
            options.crossFile.missingFileSeverity = missingFileSeverity;
        }
        if (circularDependencySeverity !== undefined) {
            options.crossFile.circularDependencySeverity = circularDependencySeverity;
        }
        if (outOfScopeSeverity !== undefined) {
            options.crossFile.outOfScopeSeverity = outOfScopeSeverity;
        }
        if (ambiguousParentSeverity !== undefined) {
            options.crossFile.ambiguousParentSeverity = ambiguousParentSeverity;
        }
        if (maxChainDepthSeverity !== undefined) {
            options.crossFile.maxChainDepthSeverity = maxChainDepthSeverity;
        }
        if (redundantDirectiveSeverity !== undefined) {
            options.crossFile.redundantDirectiveSeverity = redundantDirectiveSeverity;
        }
        if (onDemandIndexing !== undefined) {
            options.crossFile.onDemandIndexing = onDemandIndexing;
        }
        if (cache !== undefined) {
            options.crossFile.cache = cache;
        }
    }

    const diagnosticsEnabled = config.get<boolean>('diagnostics.enabled', true);
    const undefinedVariables = getExplicitSetting<boolean>(config, 'diagnostics.undefinedVariables');

    options.diagnostics = {
        enabled: diagnosticsEnabled,
    };
    if (undefinedVariables !== undefined) {
        options.diagnostics.undefinedVariables = undefinedVariables;
    }

    const packagesEnabled = getExplicitSetting<boolean>(config, 'packages.enabled');
    const additionalLibraryPaths = getExplicitSetting<string[]>(config, 'packages.additionalLibraryPaths');
    const rPath = getExplicitSetting<string>(config, 'packages.rPath');
    const missingPackageSeverity = getExplicitSetting<SeverityLevel>(config, 'packages.missingPackageSeverity');

    if (
        packagesEnabled !== undefined ||
        additionalLibraryPaths !== undefined ||
        rPath !== undefined ||
        missingPackageSeverity !== undefined
    ) {
        options.packages = {};
        if (packagesEnabled !== undefined) {
            options.packages.enabled = packagesEnabled;
        }
        if (additionalLibraryPaths !== undefined) {
            options.packages.additionalLibraryPaths = additionalLibraryPaths;
        }
        if (rPath !== undefined) {
            options.packages.rPath = rPath;
        }
        if (missingPackageSeverity !== undefined) {
            options.packages.missingPackageSeverity = missingPackageSeverity;
        }
    }

    const workspaceMaxResults = getExplicitSetting<number>(config, 'symbols.workspaceMaxResults');
    if (workspaceMaxResults !== undefined) {
        options.symbols = { workspaceMaxResults };
    }

    const triggerOnOpenParen = getExplicitSetting<boolean>(config, 'completion.triggerOnOpenParen');
    if (triggerOnOpenParen !== undefined) {
        options.completion = { triggerOnOpenParen };
    }

    const indentationStyle = getExplicitSetting<"rstudio" | "rstudio-minus" | "off">(config, 'indentation.style');
    if (indentationStyle !== undefined) {
        options.indentation = { style: indentationStyle };
    }

    return options;
}
