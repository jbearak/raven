/**
 * Property-based tests for settings transmission correctness.
 * 
 * **Feature: vscode-settings-exposure, Property 1: Settings Transmission Correctness**
 * 
 * *For any* configured Raven setting and its value, when `getInitializationOptions()` is called,
 * the returned object SHALL contain that value at the correct JSON path corresponding to the
 * LSP server's expected structure.
 * 
 * **Validates: Requirements 1.4, 2.3, 3.2, 4.3, 5.6, 6.4, 7.2, 8.5, 10.2**
 */

import * as assert from 'assert';
import * as fc from 'fast-check';
import {
    getInitializationOptions,
    RavenConfigurationInspection,
    RavenInitializationOptions,
    RavenWorkspaceConfiguration,
    SeverityLevel,
} from '../initializationOptions';

// Use mocha's describe/it which work in both standalone and VS Code test contexts
declare const suite: Mocha.SuiteFunction;
declare const test: Mocha.TestFunction;

/**
 * Assert that each setting in SETTINGS_MAPPING has the expected value in the
 * output options, given which settings were explicitly configured.
 *
 * - Configured settings must match their configured value.
 * - Unconfigured settings with a runtime default must match that default.
 * - Unconfigured settings without a default must be undefined.
 */
function assertSettingsValues(
    options: Record<string, unknown>,
    configuredSettings: Map<string, unknown>,
    /** When true, only check unconfigured settings (Property 3). */
    unconfiguredOnly = false,
): void {
    for (const setting of SETTINGS_MAPPING) {
        const isConfigured = configuredSettings.has(setting.vsCodeKey);
        if (unconfiguredOnly && isConfigured) continue;

        const outputValue = getNestedValue(options, setting.jsonPath);

        if (isConfigured) {
            const configuredValue = configuredSettings.get(setting.vsCodeKey);
            assert.deepStrictEqual(
                outputValue,
                configuredValue,
                `Setting ${setting.vsCodeKey} should appear at path ${setting.jsonPath.join('.')} with value ${JSON.stringify(configuredValue)}, but got ${JSON.stringify(outputValue)}`,
            );
        } else if (setting.defaultWhenUnconfigured !== undefined) {
            assert.deepStrictEqual(
                outputValue,
                setting.defaultWhenUnconfigured,
                `Setting ${setting.vsCodeKey} should use its runtime default at path ${setting.jsonPath.join('.')} when unconfigured`,
            );
        } else {
            assert.strictEqual(
                outputValue,
                undefined,
                `Unconfigured setting ${setting.vsCodeKey} should not appear in output, but found ${JSON.stringify(outputValue)}`,
            );
        }
    }
}

/**
 * Settings mapping from VS Code configuration keys to JSON paths in initializationOptions.
 * This is the source of truth for the property test.
 */
const SETTINGS_MAPPING: Array<{
    vsCodeKey: string;
    jsonPath: string[];
    type: 'number' | 'boolean' | 'string' | 'enum' | 'array';
    enumValues?: readonly string[];
    defaultWhenUnconfigured?: unknown;
}> = [
    // Cross-file depth settings
    { vsCodeKey: 'crossFile.backwardDependencies', jsonPath: ['crossFile', 'backwardDependencies'], type: 'enum', enumValues: ['auto', 'explicit'] as const },
    { vsCodeKey: 'crossFile.maxBackwardDepth', jsonPath: ['crossFile', 'maxBackwardDepth'], type: 'number' },
    { vsCodeKey: 'crossFile.maxForwardDepth', jsonPath: ['crossFile', 'maxForwardDepth'], type: 'number' },
    { vsCodeKey: 'crossFile.maxChainDepth', jsonPath: ['crossFile', 'maxChainDepth'], type: 'number' },
    { vsCodeKey: 'crossFile.assumeCallSite', jsonPath: ['crossFile', 'assumeCallSite'], type: 'enum', enumValues: ['start', 'end'] as const },
    { vsCodeKey: 'crossFile.indexWorkspace', jsonPath: ['crossFile', 'indexWorkspace'], type: 'boolean' },
    { vsCodeKey: 'crossFile.maxRevalidationsPerTrigger', jsonPath: ['crossFile', 'maxRevalidationsPerTrigger'], type: 'number' },
    { vsCodeKey: 'crossFile.revalidationDebounceMs', jsonPath: ['crossFile', 'revalidationDebounceMs'], type: 'number' },
    // Cross-file severity settings
    { vsCodeKey: 'crossFile.missingFileSeverity', jsonPath: ['crossFile', 'missingFileSeverity'], type: 'enum', enumValues: ['error', 'warning', 'information', 'hint', 'off'] as const },
    { vsCodeKey: 'crossFile.circularDependencySeverity', jsonPath: ['crossFile', 'circularDependencySeverity'], type: 'enum', enumValues: ['error', 'warning', 'information', 'hint', 'off'] as const },
    { vsCodeKey: 'crossFile.outOfScopeSeverity', jsonPath: ['crossFile', 'outOfScopeSeverity'], type: 'enum', enumValues: ['error', 'warning', 'information', 'hint', 'off'] as const },
    { vsCodeKey: 'crossFile.ambiguousParentSeverity', jsonPath: ['crossFile', 'ambiguousParentSeverity'], type: 'enum', enumValues: ['error', 'warning', 'information', 'hint', 'off'] as const },
    { vsCodeKey: 'crossFile.maxChainDepthSeverity', jsonPath: ['crossFile', 'maxChainDepthSeverity'], type: 'enum', enumValues: ['error', 'warning', 'information', 'hint', 'off'] as const },
    { vsCodeKey: 'crossFile.redundantDirectiveSeverity', jsonPath: ['crossFile', 'redundantDirectiveSeverity'], type: 'enum', enumValues: ['error', 'warning', 'information', 'hint', 'off'] as const },
    // On-demand indexing settings
    { vsCodeKey: 'crossFile.onDemandIndexing.enabled', jsonPath: ['crossFile', 'onDemandIndexing', 'enabled'], type: 'boolean' },
    { vsCodeKey: 'crossFile.onDemandIndexing.maxTransitiveDepth', jsonPath: ['crossFile', 'onDemandIndexing', 'maxTransitiveDepth'], type: 'number' },
    { vsCodeKey: 'crossFile.onDemandIndexing.maxQueueSize', jsonPath: ['crossFile', 'onDemandIndexing', 'maxQueueSize'], type: 'number' },
    // Cache settings
    { vsCodeKey: 'crossFile.cache.metadataMaxEntries', jsonPath: ['crossFile', 'cache', 'metadataMaxEntries'], type: 'number' },
    { vsCodeKey: 'crossFile.cache.fileContentMaxEntries', jsonPath: ['crossFile', 'cache', 'fileContentMaxEntries'], type: 'number' },
    { vsCodeKey: 'crossFile.cache.existenceMaxEntries', jsonPath: ['crossFile', 'cache', 'existenceMaxEntries'], type: 'number' },
    { vsCodeKey: 'crossFile.cache.workspaceIndexMaxEntries', jsonPath: ['crossFile', 'cache', 'workspaceIndexMaxEntries'], type: 'number' },
    // Diagnostics settings
    { vsCodeKey: 'diagnostics.enabled', jsonPath: ['diagnostics', 'enabled'], type: 'boolean', defaultWhenUnconfigured: true },
    { vsCodeKey: 'diagnostics.undefinedVariables', jsonPath: ['diagnostics', 'undefinedVariables'], type: 'boolean' },
    // Package settings
    { vsCodeKey: 'packages.enabled', jsonPath: ['packages', 'enabled'], type: 'boolean' },
    { vsCodeKey: 'packages.additionalLibraryPaths', jsonPath: ['packages', 'additionalLibraryPaths'], type: 'array' },
    { vsCodeKey: 'packages.rPath', jsonPath: ['packages', 'rPath'], type: 'string' },
    { vsCodeKey: 'packages.missingPackageSeverity', jsonPath: ['packages', 'missingPackageSeverity'], type: 'enum', enumValues: ['error', 'warning', 'information', 'hint', 'off'] as const },
    // Symbol settings
    { vsCodeKey: 'symbols.workspaceMaxResults', jsonPath: ['symbols', 'workspaceMaxResults'], type: 'number' },
    // Completion settings
    { vsCodeKey: 'completion.triggerOnOpenParen', jsonPath: ['completion', 'triggerOnOpenParen'], type: 'boolean' },
    // Indentation settings
    { vsCodeKey: 'indentation.style', jsonPath: ['indentation', 'style'], type: 'enum', enumValues: ['rstudio', 'rstudio-minus', 'off'] as const },
];

/**
 * Generate a random value for a setting based on its type.
 */
function arbitraryForSetting(setting: typeof SETTINGS_MAPPING[number]): fc.Arbitrary<unknown> {
    switch (setting.type) {
        case 'number':
            // Include 0 to align with package.json schema (minimum: 0 for revalidationDebounceMs, maxTransitiveDepth)
            return fc.integer({ min: 0, max: 100 });
        case 'boolean':
            return fc.boolean();
        case 'string':
            return fc.string({ minLength: 0, maxLength: 50 });
        case 'enum':
            return fc.constantFrom(...(setting.enumValues ?? []));
        case 'array':
            return fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 5 });
        default:
            return fc.constant(undefined);
    }
}

/**
 * Interface for mock configuration inspection result.
 */
interface MockInspection<T> extends RavenConfigurationInspection<T> {
    key: string;
}

/**
 * Create a mock VS Code WorkspaceConfiguration.
 * This simulates the behavior of vscode.workspace.getConfiguration('raven').
 */
function createMockConfig(configuredSettings: Map<string, unknown>): RavenWorkspaceConfiguration {
    return {
        get<T>(key: string, defaultValue?: T): T | undefined {
            const value = configuredSettings.get(key) as T | undefined;
            return value !== undefined ? value : defaultValue;
        },
        inspect<T>(key: string): MockInspection<T> | undefined {
            const value = configuredSettings.get(key);
            if (value !== undefined) {
                // Simulate that the value is set at global scope
                return {
                    key: `raven.${key}`,
                    globalValue: value as T,
                };
            }
            // Setting not configured - return inspection with no values
            return {
                key: `raven.${key}`,
            };
        },
    };
}

/**
 * Get a value from a nested object using a path array.
 */
function getNestedValue(obj: Record<string, unknown>, path: string[]): unknown {
    let current: unknown = obj;
    for (const key of path) {
        if (current === null || current === undefined || typeof current !== 'object') {
            return undefined;
        }
        current = (current as Record<string, unknown>)[key];
    }
    return current;
}

/**
 * Generate an arbitrary for a subset of settings to configure.
 * Returns a Map of setting keys to their values.
 */
function arbitraryConfiguredSettings(): fc.Arbitrary<Map<string, unknown>> {
    // Generate a subset of settings to configure (each setting has 50% chance of being configured)
    const settingArbitraries = SETTINGS_MAPPING.map(setting => 
        fc.tuple(
            fc.constant(setting.vsCodeKey),
            fc.boolean(), // whether to configure this setting
            arbitraryForSetting(setting)
        )
    );

    return fc.tuple(...settingArbitraries).map(tuples => {
        const configuredSettings = new Map<string, unknown>();
        for (const [key, shouldConfigure, value] of tuples) {
            if (shouldConfigure) {
                configuredSettings.set(key, value);
            }
        }
        return configuredSettings;
    });
}

suite('Settings Transmission Property Tests', () => {
    /**
     * Property 1: Settings Transmission Correctness
     * 
     * *For any* configured Raven setting and its value, when `getInitializationOptions()` is called,
     * the returned object SHALL contain that value at the correct JSON path corresponding to the
     * LSP server's expected structure.
     * 
     * **Validates: Requirements 1.4, 2.3, 3.2, 4.3, 5.6, 6.4, 7.2, 8.5, 10.2**
     */
    test('Property 1: Settings Transmission Correctness - configured settings appear at correct JSON paths', () => {
        fc.assert(
            fc.property(arbitraryConfiguredSettings(), (configuredSettings) => {
                const mockConfig = createMockConfig(configuredSettings);
                const options = getInitializationOptions(mockConfig);

                assertSettingsValues(options as Record<string, unknown>, configuredSettings);
            }),
            { numRuns: 100 }
        );
    });

    /**
     * Property 1 (continued): Single setting transmission
     * 
     * For each individual setting type, verify that when only that setting is configured,
     * it appears at the correct JSON path.
     */
    test('Property 1: Single setting transmission - each setting type transmits correctly', () => {
        for (const setting of SETTINGS_MAPPING) {
            fc.assert(
                fc.property(arbitraryForSetting(setting), (value) => {
                    const configuredSettings = new Map<string, unknown>();
                    configuredSettings.set(setting.vsCodeKey, value);

                    const mockConfig = createMockConfig(configuredSettings);
                    const options = getInitializationOptions(mockConfig);

                    const outputValue = getNestedValue(options as Record<string, unknown>, setting.jsonPath);
                    assert.deepStrictEqual(
                        outputValue,
                        value,
                        `Setting ${setting.vsCodeKey} with value ${JSON.stringify(value)} should appear at path ${setting.jsonPath.join('.')}`
                    );
                }),
                { numRuns: 20 }
            );
        }
    });

    /**
     * Property 1 (continued): All settings configured simultaneously
     * 
     * When all settings are configured, they should all appear at their correct JSON paths.
     */
    test('Property 1: All settings configured - all appear at correct paths', () => {
        const allSettingsArbitrary = fc.tuple(
            ...SETTINGS_MAPPING.map(setting => 
                fc.tuple(fc.constant(setting.vsCodeKey), arbitraryForSetting(setting))
            )
        ).map(tuples => {
            const configuredSettings = new Map<string, unknown>();
            for (const [key, value] of tuples) {
                configuredSettings.set(key, value);
            }
            return configuredSettings;
        });

        fc.assert(
            fc.property(allSettingsArbitrary, (configuredSettings) => {
                const mockConfig = createMockConfig(configuredSettings);
                const options = getInitializationOptions(mockConfig);

                for (const setting of SETTINGS_MAPPING) {
                    const configuredValue = configuredSettings.get(setting.vsCodeKey);
                    const outputValue = getNestedValue(options as Record<string, unknown>, setting.jsonPath);

                    assert.deepStrictEqual(
                        outputValue,
                        configuredValue,
                        `Setting ${setting.vsCodeKey} should appear at path ${setting.jsonPath.join('.')}`
                    );
                }
            }),
            { numRuns: 50 }
        );
    });

    /**
     * Property 3: Unconfigured Settings Omission
     * 
     * *For any* Raven setting that is not explicitly configured (uses VS Code's undefined/default),
     * the `getInitializationOptions()` function SHALL NOT include that setting in the returned object,
     * allowing the LSP server to use its own defaults.
     * 
     * **Validates: Requirements 10.4**
     */
    test('Property 3: Unconfigured settings are omitted from output', () => {
        fc.assert(
            fc.property(arbitraryConfiguredSettings(), (configuredSettings) => {
                const mockConfig = createMockConfig(configuredSettings);
                const options = getInitializationOptions(mockConfig);

                assertSettingsValues(options as Record<string, unknown>, configuredSettings, true);
            }),
            { numRuns: 100 }
        );
    });

    /**
     * Empty configuration produces only runtime-default settings.
     */
    test('Empty configuration produces runtime defaults only', () => {
        const configuredSettings = new Map<string, unknown>();
        const mockConfig = createMockConfig(configuredSettings);
        const options = getInitializationOptions(mockConfig);
        assert.deepStrictEqual(options, {
            diagnostics: {
                enabled: true,
            },
        }, 'Empty configuration should produce only runtime defaults');

    });
});

suite('Settings Transmission Unit Tests', () => {
    /**
     * Unit test: Verify specific crossFile settings transmission.
     */
    test('crossFile depth settings transmit correctly', () => {
        const configuredSettings = new Map<string, unknown>([
            ['crossFile.maxBackwardDepth', 15],
            ['crossFile.maxForwardDepth', 20],
            ['crossFile.maxChainDepth', 30],
        ]);

        const mockConfig = createMockConfig(configuredSettings);
        const options = getInitializationOptions(mockConfig);

        assert.strictEqual(options.crossFile?.maxBackwardDepth, 15);
        assert.strictEqual(options.crossFile?.maxForwardDepth, 20);
        assert.strictEqual(options.crossFile?.maxChainDepth, 30);
    });

    /**
     * Unit test: Verify assumeCallSite enum transmission.
     */
    test('assumeCallSite enum transmits correctly', () => {
        for (const value of ['start', 'end'] as const) {
            const configuredSettings = new Map<string, unknown>([
                ['crossFile.assumeCallSite', value],
            ]);

            const mockConfig = createMockConfig(configuredSettings);
            const options = getInitializationOptions(mockConfig);

            assert.strictEqual(options.crossFile?.assumeCallSite, value);
        }
    });

    /**
     * Unit test: Verify backwardDependencies enum transmission.
     */
    test('backwardDependencies enum transmits correctly', () => {
        for (const value of ['auto', 'explicit'] as const) {
            const configuredSettings = new Map<string, unknown>([
                ['crossFile.backwardDependencies', value],
            ]);

            const mockConfig = createMockConfig(configuredSettings);
            const options = getInitializationOptions(mockConfig);

            assert.strictEqual(options.crossFile?.backwardDependencies, value);
        }
    });

    /**
     * Unit test: Verify severity settings transmission.
     */
    test('severity settings transmit correctly', () => {
        const severities: SeverityLevel[] = ['error', 'warning', 'information', 'hint', 'off'];
        
        for (const severity of severities) {
            const configuredSettings = new Map<string, unknown>([
                ['crossFile.missingFileSeverity', severity],
                ['crossFile.circularDependencySeverity', severity],
                ['packages.missingPackageSeverity', severity],
            ]);

            const mockConfig = createMockConfig(configuredSettings);
            const options = getInitializationOptions(mockConfig);

            assert.strictEqual(options.crossFile?.missingFileSeverity, severity);
            assert.strictEqual(options.crossFile?.circularDependencySeverity, severity);
            assert.strictEqual(options.packages?.missingPackageSeverity, severity);
        }
    });

    /**
     * Unit test: Verify nested onDemandIndexing settings transmission.
     */
    test('onDemandIndexing nested settings transmit correctly', () => {
        const configuredSettings = new Map<string, unknown>([
            ['crossFile.onDemandIndexing.enabled', false],
            ['crossFile.onDemandIndexing.maxTransitiveDepth', 5],
            ['crossFile.onDemandIndexing.maxQueueSize', 100],
        ]);

        const mockConfig = createMockConfig(configuredSettings);
        const options = getInitializationOptions(mockConfig);

        assert.strictEqual(options.crossFile?.onDemandIndexing?.enabled, false);
        assert.strictEqual(options.crossFile?.onDemandIndexing?.maxTransitiveDepth, 5);
        assert.strictEqual(options.crossFile?.onDemandIndexing?.maxQueueSize, 100);
    });

    /**
     * Unit test: Verify diagnostics settings transmission.
     */
    test('diagnostics settings transmit correctly', () => {
        const configuredSettings = new Map<string, unknown>([
            ['diagnostics.enabled', false],
            ['diagnostics.undefinedVariables', false],
        ]);

        const mockConfig = createMockConfig(configuredSettings);
        const options = getInitializationOptions(mockConfig);

        assert.strictEqual(options.diagnostics?.enabled, false);
        assert.strictEqual(options.diagnostics?.undefinedVariables, false);
    });

    /**
     * Unit test: Verify packages settings transmission.
     */
    test('packages settings transmit correctly', () => {
        const configuredSettings = new Map<string, unknown>([
            ['packages.enabled', true],
            ['packages.additionalLibraryPaths', ['/path/to/lib1', '/path/to/lib2']],
            ['packages.rPath', '/usr/bin/R'],
            ['packages.missingPackageSeverity', 'error'],
        ]);

        const mockConfig = createMockConfig(configuredSettings);
        const options = getInitializationOptions(mockConfig);

        assert.strictEqual(options.packages?.enabled, true);
        assert.deepStrictEqual(options.packages?.additionalLibraryPaths, ['/path/to/lib1', '/path/to/lib2']);
        assert.strictEqual(options.packages?.rPath, '/usr/bin/R');
        assert.strictEqual(options.packages?.missingPackageSeverity, 'error');
    });

    /**
     * Unit test: Partial configuration only includes configured settings.
     * **Validates: Requirement 10.4**
     */
    test('partial configuration only includes configured settings', () => {
        const configuredSettings = new Map<string, unknown>([
            ['crossFile.maxBackwardDepth', 5],
            ['packages.enabled', false],
        ]);

        const mockConfig = createMockConfig(configuredSettings);
        const options = getInitializationOptions(mockConfig);

        // Configured settings should be present
        assert.strictEqual(options.crossFile?.maxBackwardDepth, 5);
        assert.strictEqual(options.packages?.enabled, false);

        // Unconfigured settings should be absent
        assert.strictEqual(options.crossFile?.maxForwardDepth, undefined);
        assert.strictEqual(options.crossFile?.assumeCallSite, undefined);
        assert.deepStrictEqual(options.diagnostics, { enabled: true });
        assert.strictEqual(options.packages?.rPath, undefined);
    });

    /**
     * Unit test: Nested onDemandIndexing with partial settings.
     * Verifies that the nested structure is created correctly when only some
     * onDemandIndexing settings are configured.
     * **Validates: Requirements 10.2, 10.4**
     */
    test('onDemandIndexing partial nested settings create correct structure', () => {
        // Only configure one nested setting
        const configuredSettings = new Map<string, unknown>([
            ['crossFile.onDemandIndexing.enabled', true],
        ]);

        const mockConfig = createMockConfig(configuredSettings);
        const options = getInitializationOptions(mockConfig);

        // The nested structure should exist with only the configured setting
        assert.strictEqual(options.crossFile?.onDemandIndexing?.enabled, true);
        assert.strictEqual(options.crossFile?.onDemandIndexing?.maxTransitiveDepth, undefined);
        assert.strictEqual(options.crossFile?.onDemandIndexing?.maxQueueSize, undefined);
    });

    /**
     * Unit test: Parent object not created when no child settings configured.
     * Verifies that parent objects (crossFile, diagnostics, packages) are not
     * created when none of their child settings are configured.
     * **Validates: Requirement 10.4**
     */
    test('parent objects not created when no child settings configured', () => {
        // Configure only packages settings - crossFile should be absent, diagnostics keep their master default
        const configuredSettings = new Map<string, unknown>([
            ['packages.enabled', true],
        ]);

        const mockConfig = createMockConfig(configuredSettings);
        const options = getInitializationOptions(mockConfig);

        assert.strictEqual(options.crossFile, undefined);
        assert.deepStrictEqual(options.diagnostics, { enabled: true });
        assert.notStrictEqual(options.packages, undefined);
        assert.strictEqual(options.packages?.enabled, true);
    });

    /**
     * Unit test: Verify nested cache settings transmission.
     */
    test('cache nested settings transmit correctly', () => {
        const configuredSettings = new Map<string, unknown>([
            ['crossFile.cache.metadataMaxEntries', 1001],
            ['crossFile.cache.fileContentMaxEntries', 501],
            ['crossFile.cache.existenceMaxEntries', 2001],
            ['crossFile.cache.workspaceIndexMaxEntries', 5001],
        ]);

        const mockConfig = createMockConfig(configuredSettings);
        const options = getInitializationOptions(mockConfig);

        assert.strictEqual(options.crossFile?.cache?.metadataMaxEntries, 1001);
        assert.strictEqual(options.crossFile?.cache?.fileContentMaxEntries, 501);
        assert.strictEqual(options.crossFile?.cache?.existenceMaxEntries, 2001);
        assert.strictEqual(options.crossFile?.cache?.workspaceIndexMaxEntries, 5001);
    });

    /**
     * Unit test: All severity settings with different values.
     * Verifies that each severity setting can be configured independently
     * with different values.
     * **Validates: Requirement 10.2**
     */
    test('all severity settings can have different values', () => {
        const configuredSettings = new Map<string, unknown>([
            ['crossFile.missingFileSeverity', 'error'],
            ['crossFile.circularDependencySeverity', 'warning'],
            ['crossFile.outOfScopeSeverity', 'information'],
            ['crossFile.ambiguousParentSeverity', 'hint'],
            ['crossFile.maxChainDepthSeverity', 'error'],
            ['packages.missingPackageSeverity', 'warning'],
        ]);

        const mockConfig = createMockConfig(configuredSettings);
        const options = getInitializationOptions(mockConfig);

        assert.strictEqual(options.crossFile?.missingFileSeverity, 'error');
        assert.strictEqual(options.crossFile?.circularDependencySeverity, 'warning');
        assert.strictEqual(options.crossFile?.outOfScopeSeverity, 'information');
        assert.strictEqual(options.crossFile?.ambiguousParentSeverity, 'hint');
        assert.strictEqual(options.crossFile?.maxChainDepthSeverity, 'error');
        assert.strictEqual(options.packages?.missingPackageSeverity, 'warning');
    });

    /**
     * Unit test: Empty array for additionalLibraryPaths.
     * Verifies that an empty array is correctly transmitted.
     * **Validates: Requirement 10.2**
     */
    test('empty array for additionalLibraryPaths transmits correctly', () => {
        const configuredSettings = new Map<string, unknown>([
            ['packages.additionalLibraryPaths', []],
        ]);

        const mockConfig = createMockConfig(configuredSettings);
        const options = getInitializationOptions(mockConfig);

        assert.deepStrictEqual(options.packages?.additionalLibraryPaths, []);
    });

    /**
     * Unit test: Empty string for rPath.
     * Verifies that an empty string is correctly transmitted.
     * **Validates: Requirement 10.2**
     */
    test('empty string for rPath transmits correctly', () => {
        const configuredSettings = new Map<string, unknown>([
            ['packages.rPath', ''],
        ]);

        const mockConfig = createMockConfig(configuredSettings);
        const options = getInitializationOptions(mockConfig);

        assert.strictEqual(options.packages?.rPath, '');
    });

    /**
     * Unit test: Boolean false values are transmitted (not omitted).
     * Verifies that explicitly configured false values are included in output.
     * **Validates: Requirements 10.2, 10.4**
     */
    test('boolean false values are transmitted not omitted', () => {
        const configuredSettings = new Map<string, unknown>([
            ['crossFile.indexWorkspace', false],
            ['crossFile.onDemandIndexing.enabled', false],
            ['diagnostics.enabled', false],
            ['diagnostics.undefinedVariables', false],
            ['packages.enabled', false],
        ]);

        const mockConfig = createMockConfig(configuredSettings);
        const options = getInitializationOptions(mockConfig);

        // All false values should be present (not omitted)
        assert.strictEqual(options.crossFile?.indexWorkspace, false);
        assert.strictEqual(options.crossFile?.onDemandIndexing?.enabled, false);
        assert.strictEqual(options.diagnostics?.enabled, false);
        assert.strictEqual(options.diagnostics?.undefinedVariables, false);
        assert.strictEqual(options.packages?.enabled, false);
    });

    /**
     * Unit test: Zero values for number settings are transmitted.
     * Verifies that zero is a valid value and is transmitted correctly.
     * **Validates: Requirement 10.2**
     */
    test('zero values for number settings are transmitted', () => {
        const configuredSettings = new Map<string, unknown>([
            ['crossFile.maxBackwardDepth', 0],
            ['crossFile.revalidationDebounceMs', 0],
            ['crossFile.onDemandIndexing.maxTransitiveDepth', 0],
        ]);

        const mockConfig = createMockConfig(configuredSettings);
        const options = getInitializationOptions(mockConfig);

        assert.strictEqual(options.crossFile?.maxBackwardDepth, 0);
        assert.strictEqual(options.crossFile?.revalidationDebounceMs, 0);
        assert.strictEqual(options.crossFile?.onDemandIndexing?.maxTransitiveDepth, 0);
    });

    /**
     * Unit test: Revalidation settings transmit correctly.
     * **Validates: Requirement 10.2**
     */
    test('revalidation settings transmit correctly', () => {
        const configuredSettings = new Map<string, unknown>([
            ['crossFile.maxRevalidationsPerTrigger', 25],
            ['crossFile.revalidationDebounceMs', 500],
        ]);

        const mockConfig = createMockConfig(configuredSettings);
        const options = getInitializationOptions(mockConfig);

        assert.strictEqual(options.crossFile?.maxRevalidationsPerTrigger, 25);
        assert.strictEqual(options.crossFile?.revalidationDebounceMs, 500);
    });

    /**
     * Unit test: indexWorkspace boolean setting transmits correctly.
     * **Validates: Requirement 10.2**
     */
    test('indexWorkspace boolean setting transmits correctly', () => {
        for (const value of [true, false]) {
            const configuredSettings = new Map<string, unknown>([
                ['crossFile.indexWorkspace', value],
            ]);

            const mockConfig = createMockConfig(configuredSettings);
            const options = getInitializationOptions(mockConfig);

            assert.strictEqual(options.crossFile?.indexWorkspace, value);
        }
    });
});
