/**
 * @file Core functionality for the Flow Scanner tool.
 *
 * This script handles fetching flow metadata from Salesforce, running the
 * analysis using the core scanner library, and rendering the results in the UI.
 * It uses React to build the user interface and interacts with the Salesforce
 * API via the `sfConn` utility.
 */

/* global React ReactDOM */
import {sfConn, apiVersion} from "./inspector.js";
import {getLinkTarget, getUserInfo, isOptionEnabled, Constants, PromptTemplate} from "./utils.js";
import ConfirmModal from "./components/ConfirmModal.js";
import {PageHeader} from "./components/PageHeader.js";

// Constants
const DEFAULT_HISTORY_SIZE = 5;
const MAX_COMPOSITE_BATCH_SIZE = 25;
const MAX_QUERY_CHUNK_SIZE = 200;
const FLOW_SCANNER_RULES_STORAGE_KEY = "flowScannerRules";
const FLOW_SCANNER_HISTORY_SIZE_KEY = "flowScannerHistorySize";

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("Metadata API prefilter requires DecompressionStream support in this browser.");
  }
  let ds;
  try {
    ds = new DecompressionStream("deflate-raw");
  } catch {
    ds = new DecompressionStream("deflate");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}

async function unzipBase64(zipBase64) {
  const zipBytes = Uint8Array.from(atob(zipBase64), c => c.charCodeAt(0));
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);

  const EOCD_SIG = 0x06054b50;
  const CEN_SIG = 0x02014b50;
  const LOC_SIG = 0x04034b50;

  const maxComment = 0xFFFF;
  const minEocdSize = 22;
  const start = Math.max(0, zipBytes.length - (minEocdSize + maxComment));
  let eocdOffset = -1;
  for (let i = zipBytes.length - minEocdSize; i >= start; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error("Invalid ZIP: EOCD not found");
  }

  const centralDirSize = view.getUint32(eocdOffset + 12, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);
  let ptr = centralDirOffset;
  const end = centralDirOffset + centralDirSize;
  const decoder = new TextDecoder("utf-8");

  const files = new Map();

  while (ptr + 46 <= end) {
    if (view.getUint32(ptr, true) !== CEN_SIG) {
      break;
    }
    const compression = view.getUint16(ptr + 10, true);
    const compressedSize = view.getUint32(ptr + 20, true);
    const fileNameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localHeaderOffset = view.getUint32(ptr + 42, true);
    const fileNameBytes = zipBytes.subarray(ptr + 46, ptr + 46 + fileNameLen);
    const fileName = decoder.decode(fileNameBytes);

    ptr += 46 + fileNameLen + extraLen + commentLen;

    if (view.getUint32(localHeaderOffset, true) !== LOC_SIG) {
      continue;
    }
    const lfNameLen = view.getUint16(localHeaderOffset + 26, true);
    const lfExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataOffset = localHeaderOffset + 30 + lfNameLen + lfExtraLen;
    const compData = zipBytes.subarray(dataOffset, dataOffset + compressedSize);

    if (compression === 0) {
      files.set(fileName, compData);
    } else if (compression === 8) {
      const inflated = await inflateRaw(compData);
      files.set(fileName, inflated);
    }
  }

  return files;
}

// Severity level mappings
const SEVERITY_MAPPING = {
  ui: {
    note: "info"
  },
  storage: {
    info: "note"
  }
};

const CORE_SEVERITY_TO_UI = {
  error: "error",
  critical: "error",
  warning: "warning",
  info: "info",
  information: "info"
};

// Flow Scanner Rules Configuration
export const flowScannerKnownConfigurableRules = {
  APIVersion: {configType: "threshold", defaultValue: 50},
  FlowName: {configType: "expression", defaultValue: "[A-Za-z0-9]+_[A-Za-z0-9]+"},
  CyclomaticComplexity: {configType: "threshold", defaultValue: 25},
};

/**
 * Checks if a configuration object has any valid (non-empty, non-null) values.
 * @param {Object} config - The configuration object to validate.
 * @returns {boolean} True if at least one valid value exists.
 */
function hasValidConfig(config) {
  if (!config) {
    return false;
  }
  return Object.values(config).some(value =>
    value !== "" && value !== null && value !== undefined && value !== false
  );
}

export function getFlowScannerRules(flowScannerCore) {
  // Retrieve core and beta rules from the scanner library
  const coreRules = typeof flowScannerCore.getRules === "function"
    ? flowScannerCore.getRules()
    : [];
  const betaRules = typeof flowScannerCore.getBetaRules === "function"
    ? flowScannerCore.getBetaRules().map(r => ({...r, isBeta: true}))
    : [];

  // Build the default rule list for merging
  const defaultRules = [...coreRules, ...betaRules].map(rule => {
    const def = {
      name: rule.name,
      label: rule.label || rule.name,
      description: rule.description,
      isBeta: rule.isBeta || false,
      // Default checked state can be customized here if needed
      checked: true,
      // Extract config details from the rule definition
      configType: rule.configType,
      defaultValue: rule.defaultValue,
      isConfigurable: rule.isConfigurable,
      // Default severity
      severity: rule.defaultSeverity || rule.severity || "error"
    };
    // For some rules, config is on the instance not the definition.
    if (rule.defaultThreshold) {
      def.configType = "threshold";
      def.defaultValue = rule.defaultThreshold;
      def.isConfigurable = true;
    }
    return def;
  });

  // Stored overrides from Options page
  const storedRules = JSON.parse(localStorage.getItem(FLOW_SCANNER_RULES_STORAGE_KEY) || "[]");

  // Merge defaults with stored overrides
  const merged = [];

  for (const def of defaultRules) {
    const stored = storedRules.find(r => r.name === def.name);
    const known = flowScannerKnownConfigurableRules[def.name];
    let config = {};
    let configType = def.configType;
    let configurable = def.configurable;

    // Apply stored override config
    if (stored && hasValidConfig(stored.config)) {
      config = stored.config;
    } else if (known) {
      config = {[known.configType]: known.defaultValue};
      configType = known.configType;
      configurable = true;
    } else if (def.defaultValue != null) {
      config = {[def.configType]: def.defaultValue};
    }

    if (known) {
      configurable = true;
      configType = configType || known.configType;
    }

    merged.push({
      ...def,
      checked: stored?.checked ?? def.checked,
      config,
      configType,
      configurable,
      configValue: stored?.configValue,
      severity: stored?.severity || def.severity
    });
  }

  return merged;
}

/**
 * Normalizes severity levels between the UI display format ("info") and
 * the storage format ("note") used by the core scanner library.
 *
 * @param {string} sev - The severity level to normalize.
 * @param {string} [direction="ui"] - The direction of normalization ('ui' or 'storage').
 * @returns {string} The normalized severity level.
 */
const normalizeSeverity = (sev, direction = "ui") => {
  const mapping = SEVERITY_MAPPING[direction];
  return mapping?.[sev] || sev;
};

/**
 * Extracts the primary affected element from a scan result.
 * @param {Object} result - The scan result object.
 * @returns {Object} The first affected element or an empty object.
 */
function getPrimaryAffectedElement(result) {
  return result.affectedElements?.[0] || {};
}

/**
 * Generates a plan for purging old flow versions, determining which versions to keep and delete.
 * @param {Array} versions - Array of flow version objects.
 * @param {number} historySize - Number of old versions to keep (in addition to active version).
 * @returns {Object} An object with keepCount and versionsToDelete.
 */
function getFlowVersionPurgePlan(versions, historySize) {
  // We want to keep the 'historySize' most recent versions + the active version (if it's not already in that set)
  // So 'keepCount' isn't just historySize + 1, it depends on where the active version falls.

  const sortedVersions = versions.sort((a, b) => b.VersionNumber - a.VersionNumber);
  const activeVersion = sortedVersions.find(v => v.Status === "Active");
  const activeVersionId = activeVersion ? activeVersion.Id : null;

  // 1. Identify the "recent" set (latest N + 1, where N is historySize)
  // The user says "keep 5 previous versions", meaning keep Current + 5 previous = 6 total from the top.
  const recentLimit = historySize + 1;
  const recentVersions = sortedVersions.slice(0, recentLimit);
  const recentVersionIds = new Set(recentVersions.map(v => v.Id));

  // 2. Identify versions to delete
  // Delete everything that is NOT in the recent set AND is NOT the active version
  const versionsToDelete = sortedVersions.filter(v => !recentVersionIds.has(v.Id) && v.Id !== activeVersionId);

  // 3. Calculate the actual number of versions we are keeping
  // Total versions - versions we are deleting
  const actualKeepCount = versions.length - versionsToDelete.length;

  return {
    keepCount: actualKeepCount,
    versionsToDelete
  };
}

/**
 * Manages the analysis of Salesforce Flows, including data fetching,
 * scanning, and results processing.
 */
class FlowScanner {
  /**
   * @param {string} sfHost - The Salesforce host URL.
   * @param {string} flowDefId - The ID of the flow definition.
   * @param {string} flowId - The ID of the specific flow version.
   */
  constructor(sfHost, flowDefId, flowId) {
    this.sfHost = sfHost;
    this.flowDefId = flowDefId;
    this.flowId = flowId;
    this.currentFlow = null;
    this.scanResults = [];
    this.flowScannerCore = null;
    this.isScanning = false;
    this._elementMap = new Map();
    // Performance optimization: cache expensive computations
    this._cachedFlowElementTypes = null;
    this._cachedExtractedElements = null;
  }

  /**
   * Constructs a Salesforce API URL.
   * @private
   * @param {string} endpoint - The API endpoint path (without /services/data/vXX).
   * @param {boolean} [isTooling=false] - Whether to use Tooling API.
   * @returns {string} The complete API URL.
   */
  _buildApiUrl(endpoint, isTooling = false) {
    const base = isTooling ? "tooling" : "";
    const prefix = base ? `/services/data/v${apiVersion}/${base}` : `/services/data/v${apiVersion}`;
    return `${prefix}${endpoint}`;
  }

  /**
   * Fetches flow versions for the current flow definition.
   * @private
   * @returns {Promise<Array>} Array of flow version records.
   */
  async _fetchFlowVersions() {
    const versionsRes = await sfConn.rest(
      this._buildApiUrl(`/query?q=SELECT+Id,VersionNumber,Status+FROM+Flow+WHERE+DefinitionId='${this.flowDefId}'+ORDER+BY+VersionNumber+DESC`, true)
    );
    return versionsRes.records || [];
  }

  /**
   * Initializes the scanner by loading flow data and running the analysis.
   */
  async init() {
    this.initFlowScannerCore();
    await this.loadFlowInfo();
    await this.scanFlow();
  }

  /**
   * Loads the core flow scanner library and sets it up for use.
   * @throws {Error} If the core scanner library is not found.
   */
  initFlowScannerCore() {
    try {
      const libraryName = window.flowScannerLibraryName;
      if (libraryName && typeof window[libraryName] !== "undefined") {
        this.flowScannerCore = window[libraryName];
      } else {
        this.flowScannerCore = null;
        throw new Error("Flow Scanner Core library not loaded or library name not defined. Please ensure lib/flow-scanner-core.js is properly included and built.");
      }
    } catch (error) {
      this.flowScannerCore = null;
      throw error;
    }
  }



  /**
   * Generates and downloads a CSV file of the scan results.
   */
  handleExportClick() {
    if (this.scanResults.length === 0) {
      return;
    }
    // Define the headers for the CSV file.
    const csvHeaders = [
      "ruleDescription",
      "ruleLabel",
      "flowName",
      "name",
      "apiName",
      "label",
      "type",
      "metaType",
      "dataType",
      "locationX",
      "locationY",
      "connectsTo",
      "expression"
    ];

    const csvRows = [csvHeaders.join(",")];

    // Convert each scan result into a CSV row.
    this.scanResults.forEach(result => {
      const affected = getPrimaryAffectedElement(result);
      const rowData = {
        ruleDescription: result.description,
        ruleLabel: result.rule,
        flowName: result.flowName,
        name: affected.elementName,
        apiName: affected.apiName,
        label: affected.elementLabel,
        type: affected.elementType,
        metaType: affected.metaType,
        dataType: affected.dataType,
        locationX: affected.locationX,
        locationY: affected.locationY,
        connectsTo: affected.connectsTo,
        expression: affected.expression
      };
      const row = csvHeaders.map(header => {
        const value = rowData[header] || "";
        // Escape quotes and wrap value in quotes for CSV format.
        const escapedValue = value.toString().replace(/"/g, '""');
        return `"${escapedValue}"`;
      });
      csvRows.push(row.join(","));
    });

    // Create a Blob and trigger a download.
    const csvContent = csvRows.join("\n");
    const blob = new Blob([csvContent], {type: "text/csv"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "flow-scan-" + this.currentFlow.name + "-" + new Date().toISOString().split("T")[0] + ".csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Fetches the flow's metadata from the Salesforce API.
   */
  async loadFlowInfo() {
    try {
      const flowInfo = await this.getFlowMetadata();
      this.currentFlow = flowInfo;
    } catch (error) {
      this.setNoRulesEnabledMessage("Failed to load flow information: " + error.message);
    }
  }

  /**
   * Finds all flows that reference this flow as a subflow using Metadata API.
   * Retrieves all Flow metadata as a ZIP, scans XML locally for subflow references.
   * Returns ALL matching flows - filtering happens client-side in the UI.
   *
   * Scan modes:
   * - fast: Metadata API only (current version only)
   * - full-history: Tooling Composite scan across all versions (slower)
   *
   * @param {Function} onProgress - Optional callback for progress updates: (current, total, message) => void
   * @param {string} scanMode - "fast" | "full-history"
   * @returns {Promise<Array>} Array of flows that reference this subflow with their versions and states.
   */
  async findReferencingFlows(onProgress, scanMode = "fast") {
    if (scanMode === "full-history") {
      if (onProgress) {
        onProgress(0, 0, "Preparing Full History Scan (Tooling Composite)...");
      }
      return this.findReferencingFlowsOLD(onProgress, false, null, true, false);
    }

    const currentFlowApiName = this.currentFlow?.apiName;
    if (!currentFlowApiName) {
      throw new Error("Current flow API name not available.");
    }

    try {
      console.log("[Metadata API] Starting retrieve for all flows...");
      console.log("[Metadata API] Searching for subflow:", currentFlowApiName);

      // Step 1: Retrieve all Flow metadata via Metadata API
      const metadataApi = sfConn.wsdl(apiVersion, "Metadata");
      const retrieveRequest = {
        apiVersion,
        unpackaged: {
          types: [{name: "Flow", members: ["*"]}]
        }
      };

      const retrieveRes = await sfConn.soap(metadataApi, "retrieve", {retrieveRequest});
      console.log("[Metadata API] Retrieve started, ID:", retrieveRes.id);
      if (onProgress) onProgress(0, 0, "Retrieve request submitted...");

      // Step 2: Poll for completion
      let statusRes;
      const startTime = Date.now();
      for (;;) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        if (onProgress) onProgress(0, 0, `Waiting for server to package flows... (${elapsed}s)`);
        statusRes = await sfConn.soap(metadataApi, "checkRetrieveStatus", {id: retrieveRes.id});
        if (statusRes.done !== "false") break;
      }

      if (statusRes.success !== "true") {
        console.error("[Metadata API] Retrieve failed:", statusRes);
        const err = new Error("Metadata API retrieve failed");
        err.result = statusRes;
        throw err;
      }

      console.log("[Metadata API] Retrieve succeeded, unzipping...");
      if (onProgress) onProgress(0, 0, "Unzipping metadata...");

      // Step 3: Unzip and parse
      const files = await unzipBase64(statusRes.zipFile);
      console.log("[Metadata API] Unzipped", files.size, "files");
      if (onProgress) onProgress(0, 0, "Scanning flow files...");

      const allPaths = Array.from(files.keys());
      console.log("[Metadata API] Sample paths:", allPaths.slice(0, 10));

      // Step 4: Scan all flow XML files for subflow references
      const flowNameRegex = new RegExp(`<flowName>${escapeRegex(currentFlowApiName)}</flowName>`);
      const statusRegex = /<status>(\w+)<\/status>/;
      const versionNumberRegex = /<processMetadataValues>[\s\S]*?<name>VersionNumber<\/name>[\s\S]*?<value>[\s\S]*?<numberValue>(\d+)<\/numberValue>/;
      const labelRegex = /<label>(.*?)<\/label>/;

      console.log("[Metadata API] Searching for subflow:", currentFlowApiName);

      const td = new TextDecoder("utf-8");
      const referencingFlows = [];
      let scannedCount = 0;
      let matchCount = 0;

      for (const [path, bytes] of files.entries()) {
        if (!path.endsWith(".flow-meta.xml") && !path.endsWith(".flow")) continue;

        scannedCount++;
        const xml = td.decode(bytes);

        if (scannedCount <= 2) {
          console.log("[Metadata API] Sample XML from", path, ":", xml.substring(0, 500));
        }

        // Check if this flow references our subflow
        if (!flowNameRegex.test(xml)) continue;

        matchCount++;
        const baseName = path.split("/").pop();
        const apiName = baseName.replace(/\.flow-meta\.xml$/i, "").replace(/\.flow$/i, "");

        // Skip self-reference
        if (apiName === currentFlowApiName) continue;

        // Extract metadata from XML
        const statusMatch = xml.match(statusRegex);
        const status = statusMatch ? statusMatch[1] : "Unknown";

        const versionMatch = xml.match(versionNumberRegex);
        const versionNumber = versionMatch ? parseInt(versionMatch[1], 10) : 0;

        const labelMatch = xml.match(labelRegex);
        const label = labelMatch ? labelMatch[1] : apiName;

        console.log("[Metadata API] MATCH #" + matchCount, ":", {apiName, status, versionNumber, label});

        referencingFlows.push({
          apiName,
          label,
          versionNumber,
          status,
          isActiveVersion: status === "Active",
          isLatestVersion: false,
          flowId: null,
          definitionId: null
        });
      }

      console.log("[Metadata API] Scanned", scannedCount, "flow files, found", matchCount, "matches (all statuses)");

      // Sort by label, then by version number descending
      referencingFlows.sort((a, b) => {
        const labelCompare = a.label.localeCompare(b.label);
        if (labelCompare !== 0) return labelCompare;
        return b.versionNumber - a.versionNumber;
      });

      if (onProgress) onProgress(referencingFlows.length, referencingFlows.length, "Scan complete");

      return referencingFlows;
    } catch (error) {
      const enhancedError = new Error(`Failed to find referencing flows: ${error.message}`);
      enhancedError.cause = error;
      enhancedError.stack = error.stack;
      throw enhancedError;
    }
  }

  /**
   * OLD IMPLEMENTATION - REPLACED WITH METADATA API ONLY
   * Keeping this comment for reference in case rollback is needed
   */
  async findReferencingFlowsOLD(onProgress, activeOnly = false, onCompositeStatus, includeInactiveVersions = false, useMetadataPrefilter = false) {
    const currentFlowApiName = this.currentFlow?.apiName;
    if (!currentFlowApiName) {
      throw new Error("Current flow API name not available.");
    }

    try {
      const flowDefMap = new Map(); // Map flowId -> flowDefinition info

      // Helper to validate Salesforce IDs (15 or 18 alphanumeric characters)
      const isValidSalesforceId = (id) => id && /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(id);
      const normalizeId = (id) => (id ? id.substring(0, 15) : id);

      const queryAll = async (soql, isTooling) => {
        const records = [];
        let res = await sfConn.rest(this._buildApiUrl(`/query?q=${encodeURIComponent(soql)}`, isTooling));
        if (res.records) records.push(...res.records);
        while (res && !res.done && res.nextRecordsUrl) {
          res = await sfConn.rest(res.nextRecordsUrl);
          if (res.records) records.push(...res.records);
        }
        return records;
      };

      const shouldExcludeFlowDefinition = (fdv) => {
        const processType = (fdv.ProcessType || "").toLowerCase();
        const triggerType = (fdv.TriggerType || "").toLowerCase();

        // Record-Triggered Flow (Before-Save / Fast Field Updates)
        // Platform Event-Triggered Flow
        // Recommendation Strategy Flow (Next Best Action)
        // User Provisioning Flows
        return triggerType === "recordbeforesave"
          || triggerType === "platformevent"
          || processType === "strategy"
          || processType === "userprovisioning";
      };

      let prefilteredApiNames = null;
      if (useMetadataPrefilter) {
        console.log("[Metadata Prefilter] Starting retrieve for all flows...");
        const metadataApi = sfConn.wsdl(apiVersion, "Metadata");
        const retrieveRequest = {
          apiVersion,
          unpackaged: {
            types: [{name: "Flow", members: ["*"]}]
          }
        };

        const retrieveRes = await sfConn.soap(metadataApi, "retrieve", {retrieveRequest});
        console.log("[Metadata Prefilter] Retrieve started, ID:", retrieveRes.id);
        let statusRes;
        for (;;) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          statusRes = await sfConn.soap(metadataApi, "checkRetrieveStatus", {id: retrieveRes.id});
          if (statusRes.done !== "false") break;
        }

        if (statusRes.success !== "true") {
          console.error("[Metadata Prefilter] Retrieve failed:", statusRes);
          let err = new Error("Metadata API retrieve failed");
          err.result = statusRes;
          throw err;
        }

        console.log("[Metadata Prefilter] Retrieve succeeded, unzipping...");
        const files = await unzipBase64(statusRes.zipFile);
        console.log("[Metadata Prefilter] Unzipped", files.size, "files");

        const allPaths = Array.from(files.keys());
        console.log("[Metadata Prefilter] Sample paths:", allPaths.slice(0, 10));
        const flowFiles = allPaths.filter(p => p.endsWith(".flow-meta.xml") || p.endsWith(".flow"));
        console.log("[Metadata Prefilter] Found", flowFiles.length, "flow files:", flowFiles.slice(0, 5));

        const candidates = new Set();
        const flowNameRegex = new RegExp(`<flowName>${escapeRegex(currentFlowApiName)}</flowName>`);
        console.log("[Metadata Prefilter] Searching for subflow:", currentFlowApiName, "with regex:", flowNameRegex);
        const td = new TextDecoder("utf-8");
        let scannedCount = 0;
        for (const [path, bytes] of files.entries()) {
          if (!path.endsWith(".flow-meta.xml") && !path.endsWith(".flow")) continue;
          scannedCount++;
          const xml = td.decode(bytes);
          if (scannedCount <= 2) {
            console.log("[Metadata Prefilter] Sample XML from", path, ":", xml.substring(0, 500));
          }
          if (flowNameRegex.test(xml)) {
            const baseName = path.split("/").pop();
            const apiName = baseName.replace(/\.flow-meta\.xml$/i, "").replace(/\.flow$/i, "");
            console.log("[Metadata Prefilter] MATCH found in", path, "-> API name:", apiName);
            if (apiName) candidates.add(apiName);
          }
        }
        console.log("[Metadata Prefilter] Scanned", scannedCount, "flow files, found", candidates.size, "candidates:", Array.from(candidates));
        prefilteredApiNames = Array.from(candidates);
        if (prefilteredApiNames.length === 0) {
          console.warn("[Metadata Prefilter] No candidates found, returning empty result");
          return [];
        }
      }

      let flowDefinitions;
      if (prefilteredApiNames) {
        flowDefinitions = [];
        for (const chunk of this._chunk(prefilteredApiNames, MAX_QUERY_CHUNK_SIZE)) {
          const namesStr = chunk.map(n => `'${n.replace(/'/g, "''")}'`).join(",");
          const soql = `SELECT DurableId, ApiName, Label, ProcessType, TriggerType, ActiveVersionId, LatestVersionId FROM FlowDefinitionView WHERE ApiName IN (${namesStr}) ORDER BY Label`;
          const records = await queryAll(soql, false);
          flowDefinitions.push(...records);
        }
      } else {
        flowDefinitions = await queryAll(
          "SELECT DurableId, ApiName, Label, ProcessType, TriggerType, ActiveVersionId, LatestVersionId FROM FlowDefinitionView ORDER BY Label",
          false
        );
      }

      if (!flowDefinitions || flowDefinitions.length === 0) {
        return [];
      }

      const definitionIdToFdv = new Map();
      const activeFlowIds = [];
      const activeAndLatestFlowIds = [];

      for (const fdv of flowDefinitions) {
        if (fdv.ApiName === currentFlowApiName) continue;
        if (shouldExcludeFlowDefinition(fdv)) continue;

        if (isValidSalesforceId(fdv.DurableId)) {
          definitionIdToFdv.set(normalizeId(fdv.DurableId), fdv);
        }
        if (isValidSalesforceId(fdv.ActiveVersionId)) {
          activeFlowIds.push(normalizeId(fdv.ActiveVersionId));
        }

        if (!activeOnly) {
          const activeId = isValidSalesforceId(fdv.ActiveVersionId) ? normalizeId(fdv.ActiveVersionId) : null;
          const latestId = isValidSalesforceId(fdv.LatestVersionId) ? normalizeId(fdv.LatestVersionId) : null;
          if (activeId) {
            activeAndLatestFlowIds.push(activeId);
            flowDefMap.set(activeId, {...fdv, isActive: true, isLatest: latestId === activeId});
          }
          if (latestId && latestId !== activeId) {
            activeAndLatestFlowIds.push(latestId);
            flowDefMap.set(latestId, {...fdv, isActive: false, isLatest: true});
          }
        }
      }

      const flowIds = [];

      if (activeOnly) {
        const seen = new Set();
        for (const id of activeFlowIds) {
          if (!id || seen.has(id)) continue;
          seen.add(id);
          const fdv = flowDefinitions.find(r => normalizeId(r.ActiveVersionId) === id);
          flowDefMap.set(id, {...fdv, isActive: true, isLatest: normalizeId(fdv?.LatestVersionId) === id});
          flowIds.push(id);
        }
      } else if (!includeInactiveVersions) {
        const seen = new Set();
        for (const id of activeAndLatestFlowIds) {
          if (!id || seen.has(id)) continue;
          seen.add(id);
          flowIds.push(id);
        }
      } else {
        const definitionIds = Array.from(definitionIdToFdv.keys());
        const allVersionFlowIds = [];
        const defIdChunks = this._chunk(definitionIds, MAX_QUERY_CHUNK_SIZE);
        for (const defChunk of defIdChunks) {
          const idsStr = defChunk.map(id => `'${id}'`).join(",");
          const soql = `SELECT Id, DefinitionId FROM Flow WHERE DefinitionId IN (${idsStr})`;
          const versionRecords = await queryAll(soql, true);
          for (const rec of versionRecords) {
            const flowId = normalizeId(rec.Id);
            const defId = normalizeId(rec.DefinitionId);
            const fdv = definitionIdToFdv.get(defId);
            if (!fdv || !flowId) continue;
            allVersionFlowIds.push(flowId);
            flowDefMap.set(flowId, {
              ...fdv,
              isActive: normalizeId(fdv.ActiveVersionId) === flowId,
              isLatest: normalizeId(fdv.LatestVersionId) === flowId
            });
          }
        }

        const seen = new Set();
        for (const id of activeAndLatestFlowIds) {
          if (!id || seen.has(id)) continue;
          seen.add(id);
          flowIds.push(id);
        }
        for (const id of allVersionFlowIds) {
          if (!id || seen.has(id)) continue;
          seen.add(id);
          flowIds.push(id);
        }
      }

      if (flowIds.length === 0) {
        if (onProgress) onProgress(0, 0, "No flow versions to scan");
        return [];
      }

      // Query flow metadata using Composite API (Metadata field requires single-row queries)
      const referencingFlows = [];
      const flowIdChunks = this._chunk(flowIds, MAX_COMPOSITE_BATCH_SIZE);
      const totalFlows = flowIds.length;
      let processedFlows = 0;

      const statusCountsAll = Object.create(null);
      const statusCountsMatched = Object.create(null);
      const normalizeStatus = (s) => s || "Unknown";
      const inc = (m, k) => {
        m[k] = (m[k] || 0) + 1;
      };
      const formatStatusCounts = (m) => {
        const ordered = ["Active", "Draft", "Obsolete", "InvalidDraft", "Unknown"];
        const parts = [];
        for (const key of ordered) {
          if (m[key]) parts.push(`${key}:${m[key]}`);
        }
        for (const [k, v] of Object.entries(m)) {
          if (ordered.includes(k)) continue;
          parts.push(`${k}:${v}`);
        }
        return parts.join(" ");
      };

      // Report initial progress
      if (onProgress) onProgress(0, totalFlows, `Scanning flow versions via Tooling Composite API... (0/${totalFlows})`);

      const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
      const maxRetries = 2;

      for (let batchIndex = 0; batchIndex < flowIdChunks.length; batchIndex++) {
        const originalChunkIds = flowIdChunks[batchIndex];
        const batchNumber = batchIndex + 1;
        const batchTotal = flowIdChunks.length;

        let remainingIds = originalChunkIds.slice();
        let attempt = 0;
        let finalFailures = [];

        while (remainingIds.length > 0 && attempt <= maxRetries) {
          const attemptIds = remainingIds;
          remainingIds = [];
          const attemptNumber = attempt + 1;

          let compositeRes;
          let requestError = null;
          try {
            const compositeRequest = attemptIds.map((flowId, idx) => ({
              method: "GET",
              url: this._buildApiUrl(`/sobjects/Flow/${flowId}?fields=Id,DefinitionId,VersionNumber,Status,Metadata`, true),
              referenceId: `flow_${batchNumber}_${attemptNumber}_${idx}`
            }));

            compositeRes = await sfConn.rest(this._buildApiUrl("/composite", true), {
              method: "POST",
              body: {allOrNone: false, compositeRequest}
            });
          } catch (e) {
            requestError = e;
          }

          let succeeded = 0;
          let failed = 0;
          const errors = [];

          if (!requestError && compositeRes?.compositeResponse) {
            for (let i = 0; i < compositeRes.compositeResponse.length; i++) {
              const subRes = compositeRes.compositeResponse[i];
              const flowId = attemptIds[i];

              if (!subRes || subRes.httpStatusCode < 200 || subRes.httpStatusCode >= 300) {
                failed++;
                remainingIds.push(flowId);
                const msg = subRes?.body?.[0]?.message || subRes?.body?.message || `HTTP ${subRes?.httpStatusCode || ""}`;
                errors.push(msg);
                continue;
              }

              succeeded++;
              const flowRecord = subRes.body;
              if (!flowRecord) continue;

              const flowStatus = normalizeStatus(flowRecord.Status);
              inc(statusCountsAll, flowStatus);

              const metadata = flowRecord.Metadata;
              if (!metadata) continue;

              const subflows = metadata.subflows;
              if (!subflows) continue;

              const subflowArray = Array.isArray(subflows) ? subflows : [subflows];
              const referencesCurrentFlow = subflowArray.some(sf => sf.flowName === currentFlowApiName);

              if (referencesCurrentFlow) {
                const fdvInfo = flowDefMap.get(normalizeId(flowRecord.Id));
                inc(statusCountsMatched, flowStatus);
                referencingFlows.push({
                  flowId: flowRecord.Id,
                  definitionId: flowRecord.DefinitionId,
                  apiName: fdvInfo?.ApiName || "Unknown",
                  label: fdvInfo?.Label || "Unknown",
                  versionNumber: flowRecord.VersionNumber,
                  status: flowRecord.Status,
                  isActiveVersion: fdvInfo?.isActive || false,
                  isLatestVersion: fdvInfo?.isLatest || flowRecord.Status === "Active"
                });
              }
            }
          } else {
            failed = attemptIds.length;
            remainingIds = attemptIds.slice();
            errors.push(requestError?.message || "Composite request failed");
          }

          if (onCompositeStatus) {
            onCompositeStatus({
              batchNumber,
              batchTotal,
              attempt: attemptNumber,
              maxRetries: maxRetries + 1,
              total: attemptIds.length,
              succeeded,
              failed,
              errors: errors.slice(0, 3)
            });
          }

          finalFailures = remainingIds.slice();
          if (remainingIds.length > 0 && attempt < maxRetries) {
            await sleep(250 * Math.pow(2, attempt));
          }
          attempt++;
        }

        processedFlows += originalChunkIds.length;
        if (onProgress) {
          const statusSummary = formatStatusCounts(statusCountsAll);
          const matchedSummary = formatStatusCounts(statusCountsMatched);
          const msg = `Scanning flow versions via Tooling Composite API... (${processedFlows}/${totalFlows})`
            + (statusSummary ? ` | Seen: ${statusSummary}` : "")
            + (referencingFlows.length ? ` | Matches: ${referencingFlows.length}` : "")
            + (matchedSummary ? ` (by status: ${matchedSummary})` : "");
          onProgress(processedFlows, totalFlows, msg);
        }

        if (finalFailures.length > 0 && onCompositeStatus) {
          onCompositeStatus({
            batchNumber,
            batchTotal,
            attempt: "final",
            maxRetries: maxRetries + 1,
            total: originalChunkIds.length,
            succeeded: originalChunkIds.length - finalFailures.length,
            failed: finalFailures.length,
            errors: ["Some requests failed after retries"]
          });
        }
      }

      // Sort by label, then by version number descending
      referencingFlows.sort((a, b) => {
        const labelCompare = a.label.localeCompare(b.label);
        if (labelCompare !== 0) return labelCompare;
        return b.versionNumber - a.versionNumber;
      });

      return referencingFlows;
    } catch (error) {
      const enhancedError = new Error(`Failed to find referencing flows: ${error.message}`);
      enhancedError.cause = error;
      enhancedError.stack = error.stack;
      throw enhancedError;
    }
  }

  /**
   * Refreshes only the flow versions list without reloading all metadata.
   * Used after purge operations for performance.
   * @returns {Promise<Array>} Updated array of flow versions.
   */
  async refreshFlowVersions() {
    try {
      const versions = await this._fetchFlowVersions();

      // Update current flow with new versions
      if (this.currentFlow) {
        this.currentFlow.versions = versions;
      }

      return versions;
    } catch (error) {
      const enhancedError = new Error(`Failed to refresh flow versions: ${error.message}`);
      enhancedError.cause = error;
      enhancedError.stack = error.stack;
      throw enhancedError;
    }
  }

  /**
   * Retrieves metadata for the current flow from the Salesforce API.
   * @returns {Object} An object containing the flow's metadata.
   * @throws {Error} If the API call fails or the flow is not found.
   */
  async getFlowMetadata() {
    try {
      // Query both Flow and FlowDefinitionView objects to get complete metadata
      const toolingCompositeUrl = this._buildApiUrl("/composite", true);

      const flowQuery = `SELECT Id,Metadata FROM Flow WHERE Id='${this.flowId}'`;
      const versionsQuery = `SELECT Id,VersionNumber,Status FROM Flow WHERE DefinitionId='${this.flowDefId}' ORDER BY VersionNumber DESC`;

      const toolingCompositeBody = {
        allOrNone: false,
        compositeRequest: [
          {
            method: "GET",
            url: this._buildApiUrl(`/query?q=${encodeURIComponent(flowQuery)}`, true),
            referenceId: "flow"
          },
          {
            method: "GET",
            url: this._buildApiUrl(`/query?q=${encodeURIComponent(versionsQuery)}`, true),
            referenceId: "versions"
          }
        ]
      };

      const [toolingResponse, fdvRes] = await Promise.all([
        sfConn.rest(toolingCompositeUrl, {
          method: "POST",
          body: toolingCompositeBody
        }),
        sfConn.rest(this._buildApiUrl(`/query/?q=SELECT+Label,ApiName,ProcessType,TriggerType,TriggerObjectOrEventLabel+FROM+FlowDefinitionView+WHERE+DurableId='${this.flowDefId}'`))
      ]);

      const compositeResponses = toolingResponse && toolingResponse.compositeResponse;
      if (!compositeResponses || !Array.isArray(compositeResponses)) {
        throw new Error("Invalid composite response structure for Flow metadata");
      }

      const flowSub = compositeResponses.find(r => r.referenceId === "flow");
      const versionsSub = compositeResponses.find(r => r.referenceId === "versions");

      const getCompositeBody = (subRes, referenceId) => {
        if (!subRes) {
          throw new Error(`Composite subrequest '${referenceId}' not found`);
        }
        const isSuccess = subRes.httpStatusCode >= 200 && subRes.httpStatusCode < 300;
        if (!isSuccess) {
          let message;
          if (Array.isArray(subRes.body) && subRes.body[0] && subRes.body[0].message) {
            message = subRes.body[0].message;
          } else if (subRes.body && subRes.body.message) {
            message = subRes.body.message;
          } else {
            message = "Unknown error";
          }
          const error = new Error(`Composite subrequest '${referenceId}' failed: ${message}`);
          error.detail = subRes.body;
          throw error;
        }
        return subRes.body;
      };

      const flowRes = getCompositeBody(flowSub, "flow");
      const versionsRes = getCompositeBody(versionsSub, "versions");
      const versions = versionsRes.records || [];

      const flowRecord = flowRes.records?.[0];
      const flowDefView = fdvRes.records?.[0];

      if (!flowRecord || !flowDefView) {
        throw new Error("Flow or FlowDefinitionView not found");
      }

      // Extract and normalize flow metadata from API responses
      const xmlData = flowRecord?.Metadata || {};
      this._removeNullAttributes(xmlData);
      const triggerObjectLabel = flowDefView?.TriggerObjectOrEventLabel || "—";
      const triggerType = flowDefView?.TriggerType || xmlData?.triggerType || null;
      const processType = flowDefView?.ProcessType || xmlData?.processType || null;
      let status = flowRecord?.Metadata?.status || "Unknown";
      let displayStatus = status;
      if (status === "InvalidDraft") {
        status = "Draft";
        displayStatus = "Draft (Invalid)";
      }
      const label = flowDefView?.Label || xmlData.label || xmlData.interviewLabel || flowDefView?.ApiName || "Unknown Label";
      const apiName = flowDefView?.ApiName || "Unknown API Name";

      // Determine flow type based on metadata
      let type = xmlData?.processType || flowDefView?.ProcessType || "Flow";
      if (Array.isArray(xmlData?.screens) && xmlData.screens.length > 0) {
        type = "ScreenFlow";
      }
      const showProcessType = type !== processType;

      // Construct complete flow information object
      const result = {
        id: this.flowId,
        definitionId: this.flowDefId,
        name: apiName,
        label,
        apiName,
        type,
        status,
        displayStatus,
        xmlData,
        triggerObjectLabel,
        triggerType,
        processType,
        showProcessType,
        versions
      };

      return result;
    } catch (error) {
      // Preserve original error stack while adding context
      const enhancedError = new Error(`Failed to fetch flow metadata: ${error.message}`);
      enhancedError.cause = error;
      enhancedError.stack = error.stack;
      throw enhancedError;
    }
  }

  /**
   * Purges old versions of the flow, keeping the specified number of recent versions + active version.
   * Uses the Composite API to delete flow interviews first, then flow versions.
   * @param {number} historySize - Number of old versions to keep.
   * @returns {Promise<{success: boolean, count: number, message: string, details: Array}>} Result summary.
   */
  async purgeOldVersions(historySize) {
    if (!this.currentFlow || !this.currentFlow.versions) {
      throw new Error("Flow versions not loaded.");
    }

    const versions = this.currentFlow.versions;
    // Sort versions by VersionNumber DESC
    // Identify the active version ID
    // Versions we want to KEEP based on recency (Latest N + 1)
    const purgePlan = getFlowVersionPurgePlan(versions, historySize);

    // Identify versions to DELETE
    // Delete if NOT in recent list AND NOT active
    const versionsToDelete = purgePlan.versionsToDelete;

    if (versionsToDelete.length === 0) {
      return {success: true, count: 0, message: "No versions to purge.", details: []};
    }

    // Initialize stats map
    // Map: versionId -> { versionId, versionNumber, interviewsFound: 0, interviewsDeleted: 0, flowDeleted: false, error: null }
    const stats = {};
    const versionIdsToDelete = [];
    // Map short (15-char) version Id -> full version Id for FlowInterview lookups
    const flowVersionIdMap = {};

    versionsToDelete.forEach(v => {
      const fullId = v.Id;
      const shortId = fullId && fullId.substring(0, 15);
      stats[fullId] = {
        versionId: fullId,
        versionNumber: v.VersionNumber,
        interviewsFound: 0,
        interviewsDeleted: 0,
        flowDeleted: false,
        error: null
      };
      if (shortId) {
        flowVersionIdMap[shortId] = fullId;
      }
      versionIdsToDelete.push(fullId);
    });

    try {
      // 1. Fetch Flow Interviews associated with these versions
      // Fetch Interviews
      let interviewIdsToDelete = [];
      // Map interviewId -> versionId
      const interviewToVersion = {};

      const versionIdChunks = this._chunk(versionIdsToDelete, MAX_QUERY_CHUNK_SIZE);
      for (const chunkIds of versionIdChunks) {
        const idsStr = chunkIds.map(id => `'${id.substring(0, 15)}'`).join(",");
        const query = `SELECT Id, FlowVersionViewId FROM FlowInterview WHERE FlowVersionViewId IN (${idsStr})`;
        const res = await sfConn.rest(this._buildApiUrl(`/query/?q=${encodeURIComponent(query)}`));
        if (res.records) {
          res.records.forEach(r => {
            interviewIdsToDelete.push(r.Id);
            const versionShortId = r.FlowVersionViewId && r.FlowVersionViewId.substring(0, 15);
            interviewToVersion[r.Id] = versionShortId;
            const versionFullId = versionShortId && flowVersionIdMap[versionShortId] ? flowVersionIdMap[versionShortId] : versionShortId;
            if (versionFullId && stats[versionFullId]) {
              stats[versionFullId].interviewsFound++;
            }
          });
        }
      }

      // 2. Construct Composite Requests
      const interviewOperations = interviewIdsToDelete.map(id => ({
        method: "DELETE",
        url: this._buildApiUrl(`/sobjects/FlowInterview/${id}`),
        referenceId: `FlowInterview_${id}`
      }));

      const versionOperations = versionIdsToDelete.map(id => ({
        method: "DELETE",
        url: this._buildApiUrl(`/sobjects/Flow/${id}`, true),
        referenceId: `Flow_${id}`
      }));

      // Execute FlowInterview deletions (Data API)
      const interviewResults = await this._executeCompositeBatch(interviewOperations, false);

      // Process interview results
      interviewResults.forEach(res => {
        if (res.referenceId.startsWith("FlowInterview_")) {
          const interviewId = res.referenceId.substring("FlowInterview_".length);
          const versionShortId = interviewToVersion[interviewId];
          const versionFullId = versionShortId && flowVersionIdMap[versionShortId] ? flowVersionIdMap[versionShortId] : versionShortId;
          if (versionFullId && stats[versionFullId] && res.success) {
            stats[versionFullId].interviewsDeleted++;
          }
        }
      });

      // Execute Flow Version deletions (Tooling API)
      const versionResults = await this._executeCompositeBatch(versionOperations, true);

      let successCount = 0;
      let errorCount = 0;

      // Process version results
      versionResults.forEach(res => {
        if (res.referenceId.startsWith("Flow_")) {
          const versionId = res.referenceId.substring("Flow_".length);
          if (stats[versionId]) {
            stats[versionId].flowDeleted = res.success;
            stats[versionId].error = res.errorMessage;
          }
          if (res.success) {
            successCount++;
          } else {
            errorCount++;
          }
        }
      });

      // Count interview failures as errors too if needed, but for now we focus on version deletion status
      // If an interview deletion fails, it usually prevents version deletion, so it will be captured there.

      const details = Object.values(stats).sort((a, b) => b.versionNumber - a.versionNumber);

      if (errorCount > 0) {
        return {
          success: successCount > 0,
          count: successCount,
          message: `Deleted ${successCount} versions. Failed to delete ${errorCount} items.`,
          details
        };
      }

      return {
        success: true,
        count: successCount,
        message: `Successfully deleted ${successCount} old versions and ${interviewIdsToDelete.length} associated flow interviews.`,
        details
      };

    } catch (error) {
      // Preserve original error for debugging
      const enhancedError = new Error(`Failed to purge versions: ${error.message}`);
      enhancedError.cause = error;
      enhancedError.stack = error.stack;
      throw enhancedError;
    }
  }

  /**
   * Splits an array into smaller chunks of a specified size.
   * @private
   * @param {Array} arr - The array to chunk.
   * @param {number} size - The size of each chunk.
   * @returns {Array} An array of chunks.
   */
  _chunk(arr, size) {
    return Array.from({length: Math.ceil(arr.length / size)}, (v, i) => arr.slice(i * size, (i * size) + size));
  }

  /**
   * Executes Salesforce Composite API requests in batches.
   * @private
   * @param {Array} operations - Array of composite request operations.
   * @param {boolean} isTooling - Whether to use Tooling API or standard API.
   * @returns {Promise<Array>} Array of result objects with success status and error messages.
   */
  async _executeCompositeBatch(operations, isTooling) {
    if (operations.length === 0) {
      return [];
    }

    const batches = this._chunk(operations, MAX_COMPOSITE_BATCH_SIZE);
    const baseUrl = this._buildApiUrl("/composite", isTooling);

    const allResults = [];

    for (const batch of batches) {
      const compositeBody = {
        allOrNone: false,
        compositeRequest: batch
      };

      try {
        const response = await sfConn.rest(baseUrl, {
          method: "POST",
          body: compositeBody
        });

        if (response && response.compositeResponse) {
          response.compositeResponse.forEach(subRes => {
            const isSuccess = (subRes.httpStatusCode >= 200 && subRes.httpStatusCode < 300);
            const errorMsg = subRes.body?.[0]?.message;

            const isAlreadyDeleted = !isSuccess
              && subRes.httpStatusCode === 404
              && errorMsg
              && (errorMsg.includes("Unable to load specified entity") || errorMsg.includes("The requested resource does not exist"));

            const finalSuccess = isSuccess || isAlreadyDeleted;
            const errorMessage = finalSuccess
              ? (isAlreadyDeleted ? "Already deleted" : null)
              : (errorMsg || "Unknown error");

            allResults.push({
              referenceId: subRes.referenceId,
              success: finalSuccess,
              errorMessage
            });
          });
        }
      } catch (batchError) {
        console.error("Composite request failed:", batchError);
        // Mark all in batch as failed
        batch.forEach(op => {
          allResults.push({
            referenceId: op.referenceId,
            success: false,
            errorMessage: `Batch request failed: ${batchError.message}`
          });
        });
      }
    }
    return allResults;
  }

  /**
   * Gets all flow element types from the core scanner library.
   * Results are cached since element types don't change during the session.
   * @private
   * @returns {Array} Array of all flow element types (nodes, resources, variables).
   */
  _getFlowElementTypes() {
    if (!this.flowScannerCore) {
      return [];
    }

    // Cache result - creating temp Flow is expensive and result never changes
    if (!this._cachedFlowElementTypes) {
      const tempFlow = new this.flowScannerCore.Flow("temp", {});
      this._cachedFlowElementTypes = [
        ...tempFlow.flowNodes,
        ...tempFlow.flowResources,
        ...tempFlow.flowVariables
      ];
    }

    return this._cachedFlowElementTypes;
  }

  /**
   * Iterates over all flow elements in the XML data and calls a callback for each.
   * @private
   * @param {Object} xmlData - The flow's XML metadata.
   * @param {Function} callback - Function to call for each element (receives element and elementType).
   */
  _forEachFlowXmlElement(xmlData, callback) {
    this._getFlowElementTypes().forEach(elementType => {
      const elements = xmlData[elementType];
      if (!elements) return;
      const elementArray = Array.isArray(elements) ? elements : [elements];
      elementArray.forEach(element => {
        callback(element, elementType);
      });
    });
  }

  /**
   * Builds a map of flow element API names to their labels for easy lookup.
   * @private
   */
  _buildElementMap() {
    this._elementMap = new Map();
    if (!this.currentFlow?.xmlData) {
      return;
    }

    const xmlData = this.currentFlow.xmlData;

    // Use element types from core library
    this._forEachFlowXmlElement(xmlData, element => {

      // Handle both single elements and arrays efficiently
      if (element?.name) {
        this._elementMap.set(element.name, element.label);
      }
    });
  }

  /**
   * Recursively removes keys with `null` values from an object.
   * Modifies the object in place.
   * @private
   * @param {Object|Array} obj - The object to clean.
   */
  _removeNullAttributes(obj) {
    if (!obj || typeof obj !== "object") {
      return;
    }

    if (Array.isArray(obj)) {
      obj.forEach(item => this._removeNullAttributes(item));
      return;
    }

    Object.keys(obj).forEach(key => {
      if (obj[key] === null) {
        delete obj[key];
      } else {
        this._removeNullAttributes(obj[key]);
      }
    });
  }

  /**
   * Initiates the flow scan, running all enabled rules and processing the results.
   */
  async scanFlow() {
    if (!this.currentFlow) {
      this.setNoRulesEnabledMessage("No flow loaded");
      return;
    }

    this.isScanning = true;

    try {
      // Ensure the core scanner library is available.
      if (!this.flowScannerCore) {
        throw new Error("Flow Scanner Core library not available");
      }

      // Check if flow type is supported before proceeding with scan
      // Use the FlowType class from the core scanner library for authoritative type definitions
      let supportedFlowTypes = [];
      let supportedFlowTypesSet = new Set();
      let unsupportedFlowTypesSet = new Set();

      if (this.flowScannerCore?.FlowType) {
        // Use the core library's FlowType definitions
        const FlowType = this.flowScannerCore.FlowType;
        // Deduplicate the array to fix the duplicate "ContactRequestFlow" issue in core library
        supportedFlowTypes = [...new Set(FlowType.allTypes())];
        supportedFlowTypesSet = new Set(supportedFlowTypes);
        const unsupportedFlowTypes = FlowType.unsupportedTypes || [];
        unsupportedFlowTypesSet = new Set(unsupportedFlowTypes);
      } else {
        // If FlowType is not available, we cannot determine supported types
        // Return an error state instead of proceeding with empty arrays
        this.scanResults = [{
          rule: "Scanner Configuration Error",
          description: "Flow type validation is unavailable. The FlowType class is not exposed by the core scanner library.",
          severity: "error",
          flowName: this.currentFlow.name,
          affectedElements: [{
            elementName: this.currentFlow.apiName,
            elementLabel: "Flow Scanner Core",
            elementType: "Configuration",
            expression: "FlowType class not available"
          }]
        }];
        return;
      }

      // Get flow type using flow properties
      const originalFlowType = this.currentFlow.xmlData?.processType || this.currentFlow.processType;
      const currentFlowType = originalFlowType || this.currentFlow.type;

      // Special case for screen flows - they might just show as "Flow" type but have screens
      const hasScreens = Array.isArray(this.currentFlow.xmlData?.screens) && this.currentFlow.xmlData.screens.length > 0;
      const isScreenFlow = currentFlowType === "Flow" && hasScreens;

      // Check if the flow type is explicitly unsupported (O(1) lookup)
      if (unsupportedFlowTypesSet.has(currentFlowType)) {
        this._setUnsupportedFlowTypeResult(currentFlowType, supportedFlowTypes, "explicitly_unsupported");
        return;
      }

      // Check if the flow type is in the supported list or if it's a screen flow (O(1) lookup)
      const isFlowTypeSupported = supportedFlowTypesSet.has(currentFlowType) || isScreenFlow;

      // If the flow type is not supported, return a special marker object.
      if (!isFlowTypeSupported) {
        const displayType = isScreenFlow ? "Screen Flow" : currentFlowType;
        this._setUnsupportedFlowTypeResult(displayType, supportedFlowTypes, "not_in_supported_list");
        return;
      }

      const flow = new this.flowScannerCore.Flow(this.currentFlow.name, this.currentFlow.xmlData);
      const parsedFlow = {flow, name: this.currentFlow.name};

      // Build a reference map of element names to labels.
      this._buildElementMap();

      // Retrieve core and beta rules from the scanner library.
      const allRules = getFlowScannerRules(this.flowScannerCore);

      // Select only enabled, built-in rules.
      const rulesToRun = allRules.filter(r => r.checked && !r.path && !r.code);
      if (rulesToRun.length === 0) {
        this.setNoRulesEnabledMessage("No Flow Scanner rules are enabled. Please enable rules on the Options page.");
        return;
      }

      let results = [];
      const ruleConfig = {rules: {}};

      // Optimize rule configuration building
      for (const rule of rulesToRun) {
        const {name, configType, config = {}, severity: uiSeverity} = rule;
        const scannerSeverity = normalizeSeverity(uiSeverity || "error", "storage");
        const entry = {severity: scannerSeverity};

        if (configType === "expression" && config.expression != null) {
          entry.expression = config.expression;
        } else if (configType === "threshold" && config.threshold != null) {
          if (name === "APIVersion") {
            // Convert numeric threshold into an expression string for the core rule.
            entry.expression = `>=${config.threshold}`;
          } else {
            entry.threshold = config.threshold;
          }
        }
        ruleConfig.rules[name] = entry;
      }

      // --- Handle APIVersion rule separately to avoid unsafe-eval in the core library ---
      const apiVersionConfig = ruleConfig.rules.APIVersion;
      if (apiVersionConfig) {
        delete ruleConfig.rules.APIVersion;
      }

      // Run all other built-in rules (if any remain).
      if (Object.keys(ruleConfig.rules).length > 0) {
        const scanResults = this.flowScannerCore.scan([parsedFlow], ruleConfig);
        results.push(...this.processScanResults(scanResults));
      }

      // Manually evaluate the APIVersion rule, if it was configured.
      if (apiVersionConfig) {
        const flowApiVer = this.currentFlow.apiVersion || this.currentFlow.xmlData?.apiVersion;
        const apiVersionRuleDef = allRules.find(r => r.name === "APIVersion");

        // Determine the required expression (e.g. ">=58").
        let requiredExpr;
        if (apiVersionConfig.expression) {
          requiredExpr = apiVersionConfig.expression;
        } else if (apiVersionConfig.threshold != null) {
          requiredExpr = `>=${apiVersionConfig.threshold}`;
        }

        if (requiredExpr) {
          const minVer = parseInt(requiredExpr.replace(/[^0-9]/g, ""), 10);
          const operator = requiredExpr.replace(/[0-9]/g, "").trim();
          const operators = {
            ">=": (a, b) => a < b,
            "<": (a, b) => a >= b,
            ">": (a, b) => a <= b,
            "<=": (a, b) => a > b,
            "==": (a, b) => a !== b,
            "=": (a, b) => a !== b
          };
          const violation = operators[operator] ? operators[operator](flowApiVer, minVer) : flowApiVer < minVer;

          if (violation) {
            // Craft a result object that mimics the core scanner output so downstream logic remains unchanged.
            const manualScanResult = [{
              flow: parsedFlow,
              ruleResults: [{
                ruleName: "APIVersion",
                ruleDefinition: {
                  description: apiVersionRuleDef?.description || "API Version check",
                  label: apiVersionRuleDef?.label || "APIVersion"
                },
                occurs: true,
                severity: apiVersionConfig.severity,
                details: [{
                  name: String(flowApiVer),
                  type: "apiVersion",
                  expression: requiredExpr
                }]
              }]
            }];
            results.push(...this.processScanResults(manualScanResult));
          }
        }
      }

      // Store final results.
      this.scanResults = results;
    } catch (error) {
      this.scanResults = [{
        rule: "Scan Error",
        description: "Failed to scan flow: " + error.message,
        severity: "error",
        flowName: this.currentFlow?.name || "Unknown",
        affectedElements: [{
          elementName: this.currentFlow?.apiName || "Unknown",
          elementLabel: "Flow",
          expression: error.message
        }]
      }];
    } finally {
      this.isScanning = false;
    }
  }

  /**
   * Sets scan results to indicate an unsupported flow type.
   * @private
   * @param {string} displayType - The display name of the unsupported flow type.
   * @param {Array<string>} supportedFlowTypes - List of supported flow types.
   * @param {string} reason - The reason why it's unsupported ('explicitly_unsupported' or 'not_in_supported_list').
   */
  _setUnsupportedFlowTypeResult(displayType, supportedFlowTypes, reason) {
    this.scanResults = [{
      isUnsupportedFlow: true,
      displayType,
      supportedFlowTypes,
      reason
    }];
  }

  /**
   * Processes raw results from the core scanner into a display-friendly format.
   * @param {Array} scanResults - The raw results from the core scanner.
   * @returns {Array} A list of formatted violation objects.
   */
  processScanResults(scanResults) {
    const results = [];

    // Helper function to create result objects
    const createResult = (rule, description, severity, affectedElements) => ({
      rule,
      description,
      severity: this.mapSeverity(severity),
      flowName: this.currentFlow.name,
      affectedElements
    });

    // Helper function to create element objects with defaults
    const createAffectedElement = (elementData) => ({
      elementName: elementData.elementName || "",
      elementType: elementData.elementType || "Unknown",
      metaType: elementData.metaType || "",
      dataType: elementData.dataType || "",
      locationX: elementData.locationX || "",
      locationY: elementData.locationY || "",
      connectsTo: elementData.connectsTo || "",
      expression: elementData.expression || "",
      elementLabel: elementData.elementLabel || "",
      apiName: elementData.apiName || ""
    });

    for (const flowResult of scanResults) {
      if (flowResult.errorMessage) {
        results.push(createResult(
          "Scan Error",
          "Failed to scan flow: " + flowResult.errorMessage,
          "error",
          [createAffectedElement({
            elementName: this.currentFlow.apiName,
            elementLabel: "Flow",
            expression: flowResult.errorMessage
          })]
        ));
        continue;
      }

      const ruleResults = flowResult.ruleResults || flowResult.results || flowResult.issues || [];

      for (const ruleResult of ruleResults) {
        if (!ruleResult.occurs) continue;

        const ruleDescription = ruleResult.ruleDefinition?.description || "No description available";
        const ruleLabel = ruleResult.ruleDefinition?.label || ruleResult.ruleName;

        if (ruleResult.details?.length > 0) {
          for (const detail of ruleResult.details) {
            const potentialElementName = detail.name || detail.violation?.name;

            let elementData;
            // Check if the violation is for a specific element or the flow itself.
            if (potentialElementName && this._elementMap.has(potentialElementName)) {
              // Element-level violation
              const violation = detail.violation || {};
              const detailsObj = detail.details || {};
              elementData = {
                elementName: potentialElementName,
                elementLabel: detail.label || violation.label || this._elementMap.get(potentialElementName) || "",
                elementType: detail.type || violation.subtype || "Unknown",
                metaType: detail.metaType || violation.metaType || "",
                dataType: detail.dataType || "",
                locationX: detailsObj.locationX || violation.locationX || "",
                locationY: detailsObj.locationY || violation.locationY || "",
                connectsTo: detailsObj.connectsTo || "",
                expression: detailsObj.expression || violation.expression || "",
                apiName: detail.apiName || violation.apiName || detail.name || violation.name || ""
              };
            } else {
              // Flow-level violation
              const rawCondition = detail.expression || detail.details?.expression || detail.violation?.expression || "";
              const condition = rawCondition.replace(/([<>=!]+)/g, "$1 ");
              elementData = {
                elementName: this.currentFlow.apiName,
                elementLabel: this.currentFlow.label,
                elementType: "Flow",
                apiName: this.currentFlow.apiName,
                expression: `${detail.name || ""} ${condition}`.trim()
              };
            }

            results.push(createResult(ruleLabel, ruleDescription, ruleResult.severity, [createAffectedElement(elementData)]));
          }
        } else {
          // Fallback for violations without specific details.
          const elementData = {
            elementName: this.currentFlow.apiName,
            elementLabel: this.currentFlow.label,
            elementType: "Flow",
            apiName: this.currentFlow.apiName,
            expression: ruleDescription
          };
          results.push(createResult(ruleLabel, ruleDescription, ruleResult.severity, [createAffectedElement(elementData)]));
        }
      }
    }
    return results;
  }

  /**
   * Maps severity levels from the core scanner to the UI's format.
   * @param {string} coreSeverity - The severity from the core scanner.
   * @returns {string} The corresponding UI severity level.
   */
  mapSeverity(coreSeverity) {
    const normalized = coreSeverity?.toLowerCase();
    return CORE_SEVERITY_TO_UI[normalized] || "info";
  }

  /**
   * Extracts all elements from the current flow's metadata.
   * Results are cached since flow data doesn't change after loading.
   * @returns {Array} A list of all flow element objects.
   */
  extractFlowElements() {
    if (!this.currentFlow?.xmlData) {
      return [];
    }

    // Cache result - flow data doesn't change during session
    if (this._cachedExtractedElements) {
      return this._cachedExtractedElements;
    }

    const elements = [];
    const xmlData = this.currentFlow.xmlData;

    // Use element types from core library
    this._forEachFlowXmlElement(xmlData, (element, elementType) => {
      elements.push({
        name: element?.name || element?.label || element?.apiName || "Unknown",
        type: elementType,
        element
      });
    });

    this._cachedExtractedElements = elements;
    return elements;
  }

  /**
   * Sets a message to be displayed when no rules are enabled or an error occurs.
   * This message is used in the UI to provide user feedback.
   * @param {string} message - The message to display.
   */
  setNoRulesEnabledMessage(message) {
    this.noRulesEnabledMessage = message;
  }
}

let h = React.createElement;

// Cache for color calculations to avoid recomputing
const versionColorCache = new Map();

function calculateVersionCountStyle(totalVersions) {
  if (totalVersions <= 0 || typeof totalVersions !== "number") {
    return {};
  }

  // Check cache first
  if (versionColorCache.has(totalVersions)) {
    return versionColorCache.get(totalVersions);
  }

  const clamped = Math.max(1, Math.min(50, totalVersions));
  const ratio = (clamped - 1) / 49;
  const startColor = {r: 46, g: 204, b: 113};
  const endColor = {r: 231, g: 76, b: 60};
  const r = Math.round(startColor.r + ((endColor.r - startColor.r) * ratio));
  const g = Math.round(startColor.g + ((endColor.g - startColor.g) * ratio));
  const b = Math.round(startColor.b + ((endColor.b - startColor.b) * ratio));
  const style = {
    backgroundColor: `rgb(${r}, ${g}, ${b})`,
    color: "#ffffff",
    padding: "0 0.4rem",
    borderRadius: "999px",
    minWidth: "2.25rem",
    textAlign: "center",
    display: "inline-block"
  };

  versionColorCache.set(totalVersions, style);
  return style;
}

function WhereUsedModal(props) {
  const {isOpen, onClose, onSearch, referencingFlows, isLoading, error, sfHost, progress, hasSearched, filterMode, onFilterModeChange, scanMode, onScanModeChange, versionScope, onVersionScopeChange, statusFilters, onStatusFilterToggle} = props;

  const normalizedStatus = (status) => status || "Unknown";
  const statusOrder = ["Active", "Draft", "Obsolete", "InvalidDraft", "Unknown"];
  const statusCounts = referencingFlows.reduce((acc, flow) => {
    const s = normalizedStatus(flow.status);
    acc[s] = (acc[s] || 0) + 1;
    return acc;
  }, {});

  // Client-side filtering based on filterMode
  const filteredFlows = referencingFlows.filter(flow => {
    const st = normalizedStatus(flow.status);
    if (scanMode === "full-history" && statusFilters) {
      if (statusFilters[st] === false) return false;
      if (statusFilters[st] === undefined) {
        if (statusFilters.Unknown === false) return false;
      }
    }

    if (scanMode === "full-history") {
      if (versionScope === "active-only") {
        if (!flow.isActiveVersion) return false;
      } else if (versionScope === "active-latest") {
        if (!flow.isActiveVersion && !flow.isLatestVersion) return false;
      }
    }

    if (filterMode === "active-only") {
      return flow.status === "Active";
    } else if (filterMode === "active-draft") {
      return flow.status === "Active" || flow.status === "Draft";
    }
    // "all" mode - return everything
    return true;
  });

  const openFlowInBuilder = (flowId, definitionId) => {
    const url = `https://${sfHost}/builder_platform_interaction/flowBuilder.app?flowId=${flowId}&flowDefId=${definitionId}`;
    window.open(url, "_blank");
  };

  const progressPercent = progress && progress.total > 0
    ? Math.round((progress.current / progress.total) * 100)
    : 0;


  return h(ConfirmModal, {
    isOpen,
    title: "Where Is This Flow Used?",
    onConfirm: onClose,
    confirmLabel: "Close",
    confirmVariant: "neutral",
    confirmType: "button"
  },
  !hasSearched && !isLoading
    ? h("div", {className: "slds-p-around_medium"},
      h("div", {className: "slds-text-body_regular slds-m-bottom_medium"},
        scanMode === "full-history"
          ? "Full History Scan uses the Tooling Composite API to scan all versions of flows (slower, most complete)."
          : "Fast Scan uses the Metadata API to retrieve one definition per flow (typically Active or latest) and scans locally in your browser."
      ),
      h("div", {className: "slds-form-element slds-m-bottom_medium"},
        h("label", {className: "slds-form-element__label", htmlFor: "where-used-scan-mode"}, "Scan mode"),
        h("div", {className: "slds-form-element__control"},
          h("div", {className: "slds-select_container"},
            h("select", {
              id: "where-used-scan-mode",
              className: "slds-select",
              value: scanMode,
              onChange: onScanModeChange
            },
            h("option", {value: "fast"}, "Fast Scan (Current Version Only)"),
            h("option", {value: "full-history"}, "Full History Scan (All Versions)"))
          )
        )
      ),
      h("div", {className: "slds-text-align_center"},
        h("button", {
          className: "slds-button slds-button_brand",
          onClick: onSearch
        }, "Start Scan")
      )
    )
    : isLoading
      ? h("div", {className: "slds-p-around_medium"},
        h("div", {className: "slds-text-align_center slds-m-bottom_small"},
          progress && progress.message
            ? progress.message
            : scanMode === "full-history"
              ? "Scanning flow versions via Tooling Composite API..."
              : "Retrieving Flow metadata via Metadata API..."
        ),
        progress && progress.total > 0
          ? h("div", {className: "slds-progress-bar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": progressPercent, role: "progressbar"},
            h("span", {className: "slds-progress-bar__value", style: {width: `${progressPercent}%`}})
          )
          : h("div", {className: "slds-progress-bar"},
            h("div", {className: "slds-progress-bar__value slds-progress-bar__value_indeterminate", style: {width: "100%"}})
          ),
        progress && progress.total > 0 && h("div", {className: "slds-text-align_center slds-m-top_small slds-text-color_weak"},
          progress.message || "Scan complete"
        )
      )
      : error
        ? h("div", {className: "slds-text-color_error"}, error)
        : referencingFlows && referencingFlows.length > 0
          ? h("div", {className: "where-used-results"},
            h("div", {className: "slds-p-around_small slds-border_bottom"},
              h("div", {className: "slds-grid slds-grid_vertical-align-center"},
                h("div", {className: "slds-col"},
                  h("p", {className: "slds-text-heading_small"},
                    `Found ${referencingFlows.length} flow${referencingFlows.length === 1 ? "" : "s"} (showing ${filteredFlows.length})`
                  )
                ),
                h("div", {className: "slds-col_bump-left"},
                  h("div", {className: "slds-form-element"},
                    h("div", {className: "slds-form-element__control"},
                      scanMode === "full-history"
                        ? h("div", {className: "slds-grid slds-wrap", style: {gap: "0.5rem", justifyContent: "flex-end"}},
                          statusOrder.map(s => h("label", {key: s, className: "slds-checkbox"},
                            h("input", {
                              type: "checkbox",
                              checked: !!statusFilters?.[s],
                              onChange: () => onStatusFilterToggle && onStatusFilterToggle(s)
                            }),
                            h("span", {className: "slds-checkbox_faux"}),
                            h("span", {className: "slds-form-element__label"}, `${s} (${statusCounts[s] || 0})`)
                          ))
                        )
                        : h("div", {className: "slds-select_container"},
                          h("select", {
                            className: "slds-select",
                            value: filterMode,
                            onChange: onFilterModeChange,
                            title: "Filter status"
                          },
                          h("option", {value: "active-only"}, "Active only"),
                          h("option", {value: "active-draft"}, "Active + Draft"),
                          h("option", {value: "all"}, "All statuses")
                          )
                        )
                    )
                  )
                )
              )
            ),
            scanMode === "full-history" && h("div", {className: "slds-p-around_small slds-border_bottom"},
              h("div", {className: "slds-form-element"},
                h("label", {className: "slds-form-element__label", htmlFor: "where-used-version-scope"}, "Version scope"),
                h("div", {className: "slds-form-element__control"},
                  h("div", {className: "slds-select_container"},
                    h("select", {
                      id: "where-used-version-scope",
                      className: "slds-select",
                      value: versionScope,
                      onChange: onVersionScopeChange
                    },
                    h("option", {value: "active-latest"}, "Active + Latest"),
                    h("option", {value: "active-only"}, "Active only"),
                    h("option", {value: "all"}, "All versions")
                    )
                  )
                )
              )
            ),
            h("div", {style: {maxHeight: "400px", overflowY: "auto"}},
              h("table", {className: "slds-table slds-table_cell-buffer slds-table_bordered"},
                h("thead", {},
                  h("tr", {className: "slds-line-height_reset"},
                    h("th", {scope: "col"}, h("div", {className: "slds-truncate", title: "Flow Label"}, "Flow Label")),
                    h("th", {scope: "col"}, h("div", {className: "slds-truncate", title: "API Name"}, "API Name")),
                    h("th", {scope: "col"}, h("div", {className: "slds-truncate slds-text-align_center", title: "Version"}, "Version")),
                    h("th", {scope: "col"}, h("div", {className: "slds-truncate slds-text-align_center", title: "Status"}, "Status")),
                    h("th", {scope: "col"}, h("div", {className: "slds-truncate slds-text-align_center", title: "Action"}, "Action"))
                  )
                ),
                h("tbody", {},
                  filteredFlows.map((flow, idx) =>
                    h("tr", {key: `${flow.apiName}-${flow.versionNumber}-${flow.flowId || "noid"}-${idx}`},
                      h("td", {}, h("div", {className: "slds-truncate", title: flow.label}, flow.label)),
                      h("td", {}, h("div", {className: "slds-truncate", title: flow.apiName, style: {fontFamily: "monospace", fontSize: "0.85em"}}, flow.apiName)),
                      h("td", {}, h("div", {className: "slds-truncate slds-text-align_center"}, flow.versionNumber)),
                      h("td", {}, h("div", {className: "slds-truncate slds-text-align_center"},
                        h("span", {
                          className: `flow-status-badge ${flow.status?.toLowerCase()}`,
                          role: "status",
                          "aria-live": "polite"
                        }, flow.status)
                      )),
                      h("td", {className: "slds-text-align_center"},
                        h("button", {
                          className: "slds-button slds-button_icon slds-button_icon-border-filled",
                          title: flow.flowId && flow.definitionId ? "Open in Flow Builder" : "Flow IDs not available in Fast Scan",
                          disabled: !(flow.flowId && flow.definitionId),
                          onClick: () => openFlowInBuilder(flow.flowId, flow.definitionId)
                        },
                        h("svg", {className: "slds-button__icon", "aria-hidden": "true"},
                          h("use", {xlinkHref: "symbols.svg#new_window"})
                        )
                        )
                      )
                    )
                  )
                )
              )
            )
          )
          : h("div", {className: "slds-align_absolute-center slds-p-around_medium"},
            h("div", {className: "slds-text-align_center"},
              h("div", {style: {fontSize: "2rem", marginBottom: "0.5rem"}}, "✅"),
              h("p", {}, "This flow is not used as a subflow by any other flow.")
            )
          )
  );
}

function FlowInfoSection(props) {
  const {flow, elements, onPurgeVersions, onWhereUsed, onToggleDescription, handleMouseDown, shouldIgnoreClick} = props;

  if (!flow) {
    return h("div", {className: "area"},
      h("div", {className: "flow-info-section"},
        h("h2", {className: "flow-info-title"},
          h("span", {className: "flow-icon", "aria-hidden": "true"}, "⚡"),
          h("span", {className: "slds-card__header-title"}, "Flow Information")
        ),
        h("div", {className: "flow-info-card compact"},
          h("div", {}, "Loading flow information...")
        )
      )
    );
  }

  const totalVersions = flow.versions ? flow.versions.length : 0;
  const versionCountStyle = calculateVersionCountStyle(totalVersions);

  return h("div", {className: "area"},
    h("div", {className: "flow-info-section", role: "region", "aria-labelledby": "flow-info-title-text"},
      h("h2", {className: "flow-info-title", style: {display: "flex", alignItems: "center", justifyContent: "space-between"}},
        h("span", {style: {display: "flex", alignItems: "center"}},
          h("span", {className: "flow-icon", "aria-hidden": "true"}, "⚡"),
          h("span", {className: "flow-info-title-text", id: "flow-info-title-text"}, "Flow Information")
        ),
        h("button", {
          className: "slds-button slds-button_neutral slds-button_small",
          onClick: onWhereUsed,
          title: "Find flows that use this flow as a subflow"
        },
        h("svg", {className: "slds-button__icon slds-button__icon_left", "aria-hidden": "true"},
          h("use", {xlinkHref: "symbols.svg#search"})
        ),
        "Where Is It Used?"
        )
      ),
      h("div", {className: "flow-info-card compact"},
        h("div", {className: "flow-header-row"},
          h("div", {className: "flow-details-grid"},
            h("div", {className: "flow-detail-item flow-label-item"},
              h("span", {className: "detail-label"}, "Flow Label"),
              h("span", {className: "detail-value"}, flow.label || "Unknown Label")
            ),
            h("div", {className: "flow-detail-item flow-apiname-item"},
              h("span", {className: "detail-label"}, "Flow API Name"),
              h("span", {className: "detail-value"}, flow.apiName || "Unknown API Name")
            ),
            h("div", {className: "flow-detail-item flow-status-item"},
              h("span", {className: "detail-label"}, "Status"),
              h("span", {
                className: `flow-status-badge ${flow.status?.toLowerCase()}`,
                role: "status",
                "aria-live": "polite",
                id: "flow-status-badge"
              }, flow.displayStatus)
            ),
            h("div", {className: "flow-detail-item flow-type-item"},
              h("span", {className: "detail-label"}, "Type"),
              h("span", {className: "detail-value", id: "flow-type"}, flow.type)
            ),
            h("div", {className: "flow-detail-item flow-apiversion-item"},
              h("span", {className: "detail-label"}, "API Version"),
              h("span", {className: "detail-value", id: "flow-api-version"}, flow.xmlData?.apiVersion || "Unknown")
            ),
            h("div", {className: "flow-detail-item flow-elements-item"},
              h("span", {className: "detail-label"}, "Elements"),
              h("span", {className: "detail-value", id: "flow-elements-count"}, elements.length)
            ),
            h("div", {className: "flow-detail-item flow-versions-item"},
              h("div", {style: {display: "flex", alignItems: "center", marginBottom: "2px"}},
                h("span", {className: "detail-label", style: {marginBottom: "0", marginRight: "4px"}}, "Versions"),
                h("div", {className: "tooltip-container"},
                  h("svg", {className: "info-icon", "aria-hidden": "true"},
                    h("use", {xlinkHref: "symbols.svg#info"})
                  ),
                  h("div", {className: "tooltip-content"}, "Total stored versions for this flow. Salesforce allows up to 50 versions per flow; the badge color shows how close you are to this limit (green = low, red = high).")
                )
              ),
              h("div", {className: "detail-value"},
                h("span", {id: "flow-versions-count", style: versionCountStyle}, flow.versions ? flow.versions.length : "Unknown"),
                (flow.versions && flow.versions.length > 1) && h("button", {
                  className: "slds-button slds-button_icon slds-button_icon-bare slds-m-left_x-small",
                  onClick: onPurgeVersions,
                  title: "Purge old versions"
                },
                h("svg", {className: "slds-button__icon", "aria-hidden": "true"},
                  h("use", {xlinkHref: "symbols.svg#delete"})
                )
                )
              )
            ),
            h("div", {className: "flow-detail-item"},
              h("span", {className: "detail-label"}, "Triggering Object/Event"),
              h("span", {className: "detail-value", id: "flow-trigger-object"}, flow.triggerObjectLabel || "—")
            ),
            h("div", {className: "flow-detail-item"},
              h("span", {className: "detail-label"}, "Trigger"),
              h("span", {className: "detail-value", id: "flow-trigger-type"}, flow.triggerType || "—")
            )
          )
        ),
        h("div", {className: "flow-desc-row"},
          h("div", {className: "flow-description-container collapsed"},
            h("div", {className: "flow-desc-header"},
              h("button", {
                className: "description-toggle-btn",
                type: "button",
                "aria-expanded": "false",
                onMouseDown: handleMouseDown,
                onClick: e => { if (shouldIgnoreClick(e)) return; onToggleDescription(e); }
              },
              h("span", {className: "toggle-icon"}, "▼"),
              h("span", {id: "toggle-label"}, "Show description")
              )
            ),
            h("div", {
              className: "flow-description clickable",
              role: "button",
              tabIndex: "0",
              "aria-label": "Click to toggle description visibility",
              dangerouslySetInnerHTML: {
                __html: (flow.xmlData?.description || "No description provided").replace(/\n/g, "<br>")
              }
            })
          )
        )
      )
    )
  );
}

function ScanSummary(props) {
  const {totalIssues, errorCount, warningCount, infoCount, onExportResults, onExpandAll, onCollapseAll, isStatItemClickable, onStatItemClick} = props;

  // Pre-calculate clickable states to avoid repeated function calls
  const errorClickable = isStatItemClickable("error", errorCount);
  const warningClickable = isStatItemClickable("warning", warningCount);
  const infoClickable = isStatItemClickable("info", infoCount);

  return h("div", {className: "summary-body", role: "status", "aria-live": "polite"},
    h("h3", {className: "summary-title slds-card__header-title"},
      h("span", {className: "results-icon"}, "📊"),
      "Scan Results"
    ),
    h("div", {className: "summary-right-panel"},
      h("div", {className: "summary-stats", role: "group", "aria-label": "Scan results summary"},
        h("div", {className: "stat-item total", role: "group", "aria-label": "Total issues"},
          h("span", {className: "stat-number", id: "total-issues-count"}, totalIssues),
          h("span", {className: "stat-label"}, "Total")
        ),
        h("div", {
          className: `stat-item error${errorClickable ? " clickable" : ""}`,
          role: "group",
          "aria-label": "Error issues",
          onClick: errorClickable ? () => onStatItemClick("error", errorCount) : undefined
        },
        h("span", {className: "stat-number", id: "error-issues-count"}, errorCount),
        h("span", {className: "stat-label"}, "Errors")
        ),
        h("div", {
          className: `stat-item warning${warningClickable ? " clickable" : ""}`,
          role: "group",
          "aria-label": "Warning issues",
          onClick: warningClickable ? () => onStatItemClick("warning", warningCount) : undefined
        },
        h("span", {className: "stat-number", id: "warning-issues-count"}, warningCount),
        h("span", {className: "stat-label"}, "Warnings")
        ),
        h("div", {
          className: `stat-item info${infoClickable ? " clickable" : ""}`,
          role: "group",
          "aria-label": "Information issues",
          onClick: infoClickable ? () => onStatItemClick("info", infoCount) : undefined
        },
        h("span", {className: "stat-number", id: "info-issues-count"}, infoCount),
        h("span", {className: "stat-label"}, "Info")
        )
      ),
      h("div", {className: "summary-actions"},
        h("button", {
          className: "slds-button slds-button_brand slds-m-right_small",
          title: "Export Results",
          onClick: onExportResults,
          disabled: totalIssues === 0
        }, "Export",
        ),
        h("button", {className: "slds-button slds-button_neutral slds-m-right_small", id: "expand-all-btn", onClick: onExpandAll}, "Expand All"),
        h("button", {className: "slds-button slds-button_neutral", id: "collapse-all-btn", onClick: onCollapseAll}, "Collapse All")
      )
    )
  );
}

function AgentforceModal(props) {
  const {isOpen, onClose, onSend, prompt, onPromptChange, analysisResult, error} = props;
  const defaultPrompt = "Based on the following Salesforce Flow metadata, explain in one paragraph what this flow does, what event triggers it, and the business purpose it serves.";
  return h(ConfirmModal, {
    isOpen,
    title: "Agentforce Flow Scanner",
    onConfirm: onSend,
    onCancel: onClose,
    confirmLabel: "Send",
    cancelLabel: "Cancel",
    confirmVariant: "brand",
    cancelVariant: "neutral"
  },
  h("div", {},
    h("div", {className: "slds-form-element"},
      h("label", {className: "slds-form-element__label"}, "Instructions"),
      h("div", {className: "slds-form-element__control"},
        h("textarea", {
          className: "slds-textarea",
          placeholder: defaultPrompt,
          value: prompt || "",
          onChange: onPromptChange,
          style: {minHeight: "120px", resize: "vertical"}
        })
      )
    ),
    error && h("div", {className: "slds-box slds-m-top_medium slds-theme_error slds-theme_alert-texture"},
      h("div", {className: "slds-text-heading_small slds-m-bottom_small"}, "Error"),
      h("div", {className: "slds-text-body_regular"}, error)
    ),
    analysisResult && h("div", {className: "slds-box slds-m-top_medium"},
      h("div", {className: "slds-text-heading_small slds-m-bottom_small"}, "Analysis Result"),
      h("div", {className: "slds-text-body_regular", style: {whiteSpace: "pre-wrap"}}, analysisResult)
    )
  )
  );
}

function PurgeModal(props) {
  const {
    isOpen,
    purgeHistorySize,
    purgeDetails,
    purgeWarning,
    maxHistory,
    onConfirm,
    onCancel,
    onHistorySizeChange
  } = props;

  return h(ConfirmModal, {
    isOpen,
    title: "Purge Old Versions",
    onConfirm,
    onCancel,
    confirmLabel: "Purge",
    cancelLabel: "Cancel",
    confirmVariant: "destructive",
    cancelVariant: "neutral",
    confirmIconName: "symbols.svg#delete",
    confirmIconPosition: "left",
    confirmDisabled: !purgeDetails || purgeDetails.toDeleteCount === 0,
    confirmType: "button",
    cancelType: "button"
  },
  h("div", {style: {display: "flex", alignItems: "center", gap: "1rem"}},
    h("label", {className: "slds-form-element__label", style: {marginBottom: "0"}}, "Number of previous versions to keep (in addition to the current version):"),
    h("div", {className: "slds-form-element__control"},
      h("input", {
        type: "number",
        className: "slds-input",
        style: {width: "80px"},
        value: purgeHistorySize,
        onChange: onHistorySizeChange,
        min: "0",
        max: maxHistory
      })
    )
  ),
  h("div", {style: {minHeight: "1.2em", paddingTop: "0.25rem"}},
    purgeDetails && (
      purgeDetails.toDeleteCount === 0
        ? h("div", {className: "slds-text-color_weak"},
          "With this setting, no older versions will be deleted."
        )
        : h("div", {className: "slds-text-color_weak"},
          `You will keep the current version and ${purgeDetails.keepCount - 1} previous version${(purgeDetails.keepCount - 1) === 1 ? "" : "s"}, and delete ${purgeDetails.toDeleteCount} older version${purgeDetails.toDeleteCount === 1 ? "" : "s"}.`
        )
    )
  ),
  purgeWarning && h("div", {className: "slds-text-color_error", style: {marginTop: "0.25rem"}},
    purgeWarning
  ),
  purgeDetails
    ? (purgeDetails.toDeleteCount === 0
      ? h("div", {className: "slds-text-color_weak slds-m-vertical_small"},
        h("p", {}, "There are no older versions to purge with this setting."),
        h("p", {}, "To delete old versions, lower the number of previous versions to keep above.")
      )
      : [
        h("p", {key: "p1", className: "slds-m-bottom_small"}, `When you confirm, Salesforce will permanently delete ${purgeDetails.toDeleteCount} older version${purgeDetails.toDeleteCount === 1 ? "" : "s"} of this flow.`),
        h("p", {key: "p2", className: "slds-text-color_error"}, "This will also delete any related Flow Interviews (in-progress flow runs) for those versions, and it cannot be undone.")
      ]
    )
    : null
  );
}

/**
 * The main React component for the Flow Scanner application.
 */
class App extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      isLoading: true,
      loadingMessage: "Loading Flow Data...",
      loadingDescription: "Please wait while we retrieve the flow metadata from Salesforce.",
      userInfo: "...",
      userInitials: "",
      userFullName: "",
      userName: "",
      orgName: "",
      spinnerCount: 0,
      // Accordion state: { [severity]: { expanded: bool, rules: { [ruleType]: bool } } }
      accordion: {
        error: {expanded: true, rules: {}},
        warning: {expanded: true, rules: {}},
        info: {expanded: true, rules: {}}
      },
      hideButtonsOption: JSON.parse(localStorage.getItem("hideFlowScannerButtonsOption")),
      showAgentforceModal: false,
      agentforcePrompt: "",
      agentforceAnalysis: "",
      agentforceError: null,
      showWhereUsedModal: false,
      whereUsedLoading: false,
      whereUsedError: null,
      referencingFlows: [],
      whereUsedProgress: {current: 0, total: 0, message: ""},
      whereUsedHasSearched: false,
      whereUsedFilterMode: "active-draft",
      whereUsedScanMode: "fast",
      whereUsedVersionScope: "active-latest",
      whereUsedStatusFilters: {
        Active: true,
        Draft: true,
        Obsolete: false,
        InvalidDraft: false,
        Unknown: false
      }
    };
    this.onToggleHelp = this.onToggleHelp.bind(this);
    this.onToggleAgentforce = this.onToggleAgentforce.bind(this);
    this.onAgentforceClose = this.onAgentforceClose.bind(this);
    this.onAgentforceSend = this.onAgentforceSend.bind(this);
    this.onAgentforcePromptChange = this.onAgentforcePromptChange.bind(this);
    this.onToggleDescription = this.onToggleDescription.bind(this);
    this.onExportResults = this.onExportResults.bind(this);
    this.onExpandAll = this.onExpandAll.bind(this);
    this.onCollapseAll = this.onCollapseAll.bind(this);
    this.onSeverityToggle = this.onSeverityToggle.bind(this);
    this.onRuleToggle = this.onRuleToggle.bind(this);
    this.onStatItemClick = this.onStatItemClick.bind(this);
    this.onPurgeVersions = this.onPurgeVersions.bind(this);
    this.onPurgeHistorySizeChange = this.onPurgeHistorySizeChange.bind(this);
    this.confirmPurge = this.confirmPurge.bind(this);
    this.cancelPurge = this.cancelPurge.bind(this);
    this.closePurgeResult = this.closePurgeResult.bind(this);
    this.retryAfterError = this.retryAfterError.bind(this);
    this.computePurgeState = this.computePurgeState.bind(this);
    this.onWhereUsed = this.onWhereUsed.bind(this);
    this.onWhereUsedClose = this.onWhereUsedClose.bind(this);
    this.onWhereUsedSearch = this.onWhereUsedSearch.bind(this);
    this.onWhereUsedFilterModeChange = this.onWhereUsedFilterModeChange.bind(this);
    this.onWhereUsedScanModeChange = this.onWhereUsedScanModeChange.bind(this);
    this.onWhereUsedVersionScopeChange = this.onWhereUsedVersionScopeChange.bind(this);
    this.onWhereUsedStatusFilterToggle = this.onWhereUsedStatusFilterToggle.bind(this);
  }

  componentDidMount() {
    this.initializeFlowScanner();
  }

  retryAfterError() {
    this.setState({
      error: null,
      isLoading: true,
      loadingMessage: "Reloading flow data...",
      loadingDescription: "Please wait while we retry loading the flow."
    }, () => {
      this.initializeFlowScanner();
    });
  }

  computePurgeState(rawHistorySize) {
    const flow = this.flowScanner?.currentFlow;
    const versions = flow?.versions || [];
    const totalVersions = versions.length;
    const maxHistory = Math.max(0, totalVersions - 1);

    const historySizeInvalid = isNaN(rawHistorySize) || rawHistorySize < 0;
    let historySize = rawHistorySize;
    let purgeWarning = null;

    if (historySizeInvalid) {
      // If stored value is corrupted, keep everything (delete nothing)
      historySize = maxHistory;
      purgeWarning = "Stored Flow History Size value is invalid. No versions will be deleted. Update the setting on the Options page.";
    } else if (historySize > maxHistory) {
      historySize = maxHistory;
    }

    const purgePlan = getFlowVersionPurgePlan([...versions], historySize);
    const keepCount = purgePlan.keepCount;
    const versionsToDelete = purgePlan.versionsToDelete;

    return {
      historySize,
      purgeWarning,
      purgeDetails: {
        keepCount,
        toDeleteCount: versionsToDelete.length
      }
    };
  }

  /**
   * Groups scan results by severity and rule type.
   * @returns {Object} An object containing the grouped results.
   */
  getGroupedResults() {
    const {scanResults} = this.flowScanner || {};
    if (!scanResults || scanResults.length === 0) {
      return {error: {results: [], rules: {}}, warning: {results: [], rules: {}}, info: {results: [], rules: {}}};
    }
    const severityOrder = ISSUE_SEVERITY_ORDER;
    const grouped = {};
    severityOrder.forEach(severity => {
      grouped[severity] = {results: [], rules: {}};
    });
    scanResults.forEach(result => {
      const {severity} = result;
      if (grouped[severity]) {
        grouped[severity].results.push(result);
      }
    });
    severityOrder.forEach(severity => {
      const rules = {};
      grouped[severity].results.forEach(result => {
        const ruleType = result.rule || "Unknown Rule";
        if (!rules[ruleType]) {
          rules[ruleType] = [];
        }
        rules[ruleType].push(result);
      });
      grouped[severity].rules = rules;
    });
    return grouped;
  }

  componentDidUpdate() {
    // When scan results are loaded, initialize accordion state for any new rules.
    const {scanResults} = this.flowScanner || {};
    if (scanResults && scanResults.length > 0) {
      const groupedResults = this.getGroupedResults();
      let needsUpdate = false;
      const accordion = {...this.state.accordion};
      Object.keys(groupedResults).forEach(severity => {
        if (!accordion[severity]) accordion[severity] = {expanded: true, rules: {}};
        if (!accordion[severity].rules) accordion[severity].rules = {};
        const {rules} = groupedResults[severity];
        Object.keys(rules).forEach(ruleType => {
          if (!(ruleType in accordion[severity].rules)) {
            accordion[severity].rules[ruleType] = true;
            needsUpdate = true;
          }
        });
      });
      if (needsUpdate) {
        this.setState({accordion});
      }
    }
  }

  async initializeFlowScanner() {
    try {
      // Clear any previous error state before starting a new initialization
      this.setState({error: null});
      const params = new URLSearchParams(window.location.search);
      const sfHost = params.get("host");
      const flowDefId = params.get("flowDefId");
      const flowId = params.get("flowId");

      if (!sfHost || !flowDefId || !flowId) {
        throw new Error(`Missing required parameters: host=${sfHost}, flowDefId=${flowDefId}, flowId=${flowId}`);
      }

      window.initButton(sfHost, true);

      if (typeof sfConn === "undefined") {
        throw new Error("sfConn not found. Make sure inspector.js is loaded.");
      }

      await sfConn.getSession(sfHost);

      // Set org name from sfHost
      const orgName = sfHost.split(".")[0]?.toUpperCase() || "";
      this.setState({orgName});

      // Fetch user info using utility function
      getUserInfo().then(result => {
        this.setState({
          userInfo: result.userInfo,
          userInitials: result.userInitials,
          userFullName: result.userFullName,
          userName: result.userName
        });
      });

      this.flowScanner = new FlowScanner(sfHost, flowDefId, flowId);
      await this.flowScanner.init();

      this.setState({isLoading: false, error: null});
    } catch (error) {
      this.setState({
        isLoading: false,
        error: error.message
      });
    }
  }

  onToggleHelp(e) {
    e.preventDefault();
    const target = getLinkTarget(e);
    const url = chrome.runtime.getURL(`options.html?selectedTab=flow-scanner&host=${this.flowScanner?.sfHost}`);
    window.open(url, target);
  }

  onToggleAgentforce(e) {
    if (e) {
      e.preventDefault();
    }
    this.setState({
      showAgentforceModal: true
    });
  }

  onAgentforceClose() {
    this.setState({
      showAgentforceModal: false,
      agentforcePrompt: "",
      agentforceAnalysis: "",
      agentforceError: null
    });
  }

  async onAgentforceSend() {
    const defaultPrompt = "Based on the following Salesforce Flow metadata, explain in one paragraph what this flow does, what event triggers it, and the business purpose it serves.";
    const instructions = this.state.agentforcePrompt || defaultPrompt;

    this.setState({
      showAgentforceModal: false,
      isLoading: true,
      loadingMessage: "Generating explanation...",
      loadingDescription: "Asking Agentforce to analyze the flow metadata.",
      agentforceError: null,
      agentforceAnalysis: ""
    });

    try {
      const promptTemplateName = localStorage.getItem(this.flowScanner.sfHost + "_flowScannerAgentForcePrompt");
      const templateName = promptTemplateName || Constants.PromptTemplateFlow;
      const promptTemplate = new PromptTemplate(templateName);

      // Use the XML metadata as the context for the prompt
      const flowMetadata = this.flowScanner?.currentFlow?.xmlData ? JSON.stringify(this.flowScanner.currentFlow.xmlData) : "";

      const result = await promptTemplate.generate({
        Description: instructions,
        FlowMetadata: flowMetadata
      });

      if (result.success) {
        // Extract analysis from the result (using [\s\S] to match across newlines)
        const flowMatch = result.result.match(/<flowAnalysis>([\s\S]*?)<\/flowAnalysis>/);
        const extractedAnalysis = flowMatch ? flowMatch[1].trim() : result.result;
        this.setState({
          isLoading: false,
          showAgentforceModal: true,
          agentforceAnalysis: extractedAnalysis
        });
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      this.setState({
        isLoading: false,
        showAgentforceModal: true, // Re-open modal so user can try again or see their input
        agentforceError: "Agentforce generation failed: " + error.message
      });
    }
  }

  onAgentforcePromptChange(e) {
    this.setState({agentforcePrompt: e.target.value});
  }

  onToggleDescription(e) {
    e.preventDefault();
    const container = e.target.closest(".flow-description-container");
    const toggleBtn = container?.querySelector(".description-toggle-btn");
    if (container && toggleBtn) {
      const isCollapsed = container.classList.toggle("collapsed");
      toggleBtn.setAttribute("aria-expanded", !isCollapsed);
      const toggleLabel = toggleBtn.querySelector("#toggle-label");
      if (toggleLabel) {
        toggleLabel.textContent = isCollapsed ? "Show description" : "Hide description";
      }
    }
  }

  onExportResults() {
    if (this.flowScanner) {
      this.flowScanner.handleExportClick();
    }
  }

  onExpandAll() {
    this.setState(state => {
      const accordion = {...state.accordion};
      ISSUE_SEVERITY_ORDER.forEach(sev => {
        accordion[sev].expanded = true;
        const rules = accordion[sev].rules;
        Object.keys(rules).forEach(rule => { rules[rule] = true; });
      });
      return {accordion};
    });
  }

  onCollapseAll() {
    this.setState(state => {
      const accordion = {...state.accordion};
      const anyRuleExpanded = ISSUE_SEVERITY_ORDER.some(sev =>
        Object.values(accordion[sev].rules).some(isExpanded => isExpanded)
      );
      if (anyRuleExpanded) {
        // If any rules are expanded, collapse all rules but keep severity groups open.
        ISSUE_SEVERITY_ORDER.forEach(sev => {
          const rules = accordion[sev].rules;
          Object.keys(rules).forEach(rule => { rules[rule] = false; });
        });
      } else {
        // If all rules are collapsed, collapse the severity groups themselves.
        ISSUE_SEVERITY_ORDER.forEach(sev => {
          accordion[sev].expanded = false;
        });
      }
      return {accordion};
    });
  }

  onSeverityToggle(severity) {
    this.setState(state => {
      const accordion = {...state.accordion};
      const sevAcc = accordion[severity];
      const ruleKeys = Object.keys(sevAcc.rules || {});
      const expandedRules = ruleKeys.filter(r => sevAcc.rules[r]);
      const allRulesExpanded = expandedRules.length === ruleKeys.length;
      const isGroupCollapsed = !sevAcc.expanded;

      // This logic cycles through three states:
      // 1. Collapsed group -> Expand group, keeping rule states.
      // 2. Expanded group with some/all rules collapsed -> Expand all rules.
      // 3. Expanded group with all rules expanded -> Collapse group.
      if (isGroupCollapsed) {
        sevAcc.expanded = true;
      } else if (allRulesExpanded) {
        sevAcc.expanded = false;
      } else {
        ruleKeys.forEach(r => { sevAcc.rules[r] = true; });
      }

      return {accordion};
    });
  }

  onRuleToggle(severity, ruleType) {
    this.setState(state => {
      const accordion = {...state.accordion};
      if (!accordion[severity].rules) accordion[severity].rules = {};
      accordion[severity].rules[ruleType] = !accordion[severity].rules[ruleType];
      return {accordion};
    });
  }

  isStatItemClickable(severity, count) {
    return count > 0 && severity !== "total";
  }

  onStatItemClick(severity, count) {
    if (!this.isStatItemClickable(severity, count)) {
      return;
    }

    // Ensure the severity section is expanded
    this.setState(state => {
      const accordion = {...state.accordion};
      if (!accordion[severity].expanded) {
        accordion[severity].expanded = true;
      }
      return {accordion};
    }, () => {
      // After state update, scroll to the section
      setTimeout(() => {
        const targetId = `${severity}-rules-container`;
        const targetElement = document.getElementById(targetId);
        if (targetElement) {
          targetElement.scrollIntoView({
            behavior: "smooth",
            block: "start"
          });
        }
      }, 100);
    });
  }

  // Helper to record mousedown coordinates.
  handleMouseDown(e) {
    const el = e.currentTarget;
    el.dataset.startX = e.clientX;
    el.dataset.startY = e.clientY;
  }

  // Helper to ignore click if user dragged to select text.
  shouldIgnoreClick(e) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) {
      const el = e.currentTarget;
      const dx = Math.abs(e.clientX - Number(el.dataset.startX));
      const dy = Math.abs(e.clientY - Number(el.dataset.startY));
      return dx > 3 || dy > 3;
    }
    return false;
  }

  onPurgeHistorySizeChange(e) {
    let newSize = parseInt(e.target.value, 10);
    if (isNaN(newSize) || newSize < 0) return;

    const {historySize, purgeDetails} = this.computePurgeState(newSize);

    this.setState({
      purgeHistorySize: historySize,
      purgeDetails,
      purgeWarning: null
    });
  }

  async onPurgeVersions() {
    const rawHistorySize = parseInt(localStorage.getItem(FLOW_SCANNER_HISTORY_SIZE_KEY) || String(DEFAULT_HISTORY_SIZE), 10);
    const {historySize, purgeDetails, purgeWarning} = this.computePurgeState(rawHistorySize);

    this.setState({
      showPurgeModal: true,
      purgeHistorySize: historySize,
      purgeWarning,
      purgeDetails
    });
  }

  async confirmPurge() {
    this.setState({showPurgeModal: false, isLoading: true, loadingMessage: "Purging old versions..."});
    const historySize = this.state.purgeHistorySize;

    try {
      const result = await this.flowScanner.purgeOldVersions(historySize);
      this.setState({
        isLoading: false,
        showPurgeResultModal: true,
        purgeResult: result
      });
    } catch (error) {
      this.setState({
        isLoading: false,
        error: "Purge failed: " + error.message
      });
    }
  }

  async closePurgeResult() {
    this.setState({showPurgeResultModal: false, purgeResult: null, isLoading: true, loadingMessage: "Refreshing version count..."});

    try {
      // Only refresh versions, not the entire flow data
      await this.flowScanner.refreshFlowVersions();

      // Force React to re-render with updated version data
      this.setState({isLoading: false});
    } catch (error) {
      console.error("Failed to refresh versions:", error);
      // Fall back to full reload if version refresh fails
      await this.initializeFlowScanner();
    }
  }

  cancelPurge() {
    this.setState({showPurgeModal: false});
  }

  onWhereUsed() {
    this.setState({
      showWhereUsedModal: true,
      referencingFlows: [],
      whereUsedProgress: {current: 0, total: 0, message: ""},
      whereUsedHasSearched: false
    });
  }

  async onWhereUsedSearch() {
    this.setState({
      whereUsedLoading: true,
      whereUsedError: null,
      referencingFlows: [],
      whereUsedProgress: {current: 0, total: 0, message: ""},
      whereUsedHasSearched: true
    });

    try {
      const onProgress = (current, total, message = "") => {
        this.setState({whereUsedProgress: {current, total, message}});
      };

      const referencingFlows = await this.flowScanner.findReferencingFlows(onProgress, this.state.whereUsedScanMode);
      this.setState({
        whereUsedLoading: false,
        referencingFlows
      });
    } catch (error) {
      this.setState({
        whereUsedLoading: false,
        whereUsedError: error.message
      });
    }
  }

  onWhereUsedFilterModeChange(e) {
    const value = e.target.value;
    this.setState({whereUsedFilterMode: value});
  }

  onWhereUsedScanModeChange(e) {
    const value = e.target.value;
    this.setState({whereUsedScanMode: value});
  }

  onWhereUsedVersionScopeChange(e) {
    const value = e.target.value;
    this.setState({whereUsedVersionScope: value});
  }

  onWhereUsedStatusFilterToggle(status) {
    this.setState(prev => ({
      whereUsedStatusFilters: {
        ...prev.whereUsedStatusFilters,
        [status]: !prev.whereUsedStatusFilters?.[status]
      }
    }));
  }

  onWhereUsedClose() {
    this.setState({
      showWhereUsedModal: false,
      whereUsedLoading: false,
      whereUsedError: null,
      referencingFlows: []
    });
  }

  renderPurgeResultModal() {
    if (!this.state.showPurgeResultModal || !this.state.purgeResult) return null;

    const {details} = this.state.purgeResult;

    return h(ConfirmModal, {
      isOpen: true,
      title: "Purge Results",
      onConfirm: this.closePurgeResult,
      confirmLabel: "Close",
      confirmVariant: this.state.purgeResult.success ? "brand" : "destructive-text",
      confirmIconName: this.state.purgeResult.success ? "symbols.svg#success" : "symbols.svg#error",
      confirmIconPosition: "left",
      confirmType: "button"
    },
    h("div", {className: "purge-results-container", style: {maxHeight: "400px", overflowY: "auto"}},
      h("p", {className: this.state.purgeResult.success ? "slds-text-color_success" : "slds-text-color_error"},
        this.state.purgeResult.message
      ),
      details && details.length > 0 && h("table", {className: "slds-table slds-table_cell-buffer slds-table_bordered slds-m-top_small"},
        h("thead", {},
          h("tr", {className: "slds-line-height_reset"},
            h("th", {scope: "col"}, h("div", {className: "slds-truncate slds-text-align_center", title: "Version"}, "Version")),
            h("th", {scope: "col"}, h("div", {className: "slds-truncate slds-text-align_center", title: "Flow Status"}, "Flow Status")),
            h("th", {scope: "col"}, h("div", {className: "slds-truncate slds-text-align_center", title: "Interviews Deleted"}, "Interviews Deleted")),
            h("th", {scope: "col"}, h("div", {className: "slds-truncate slds-text-align_center", title: "Error"}, "Error"))
          )
        ),
        h("tbody", {},
          details.map(d => {
            const failedInterviews = d.interviewsFound - d.interviewsDeleted;
            let interviewsLabel;
            if (!d.interviewsFound) {
              interviewsLabel = "No interviews";
            } else {
              interviewsLabel = `${d.interviewsDeleted} / ${d.interviewsFound}`;
              if (failedInterviews > 0) {
                interviewsLabel += ` (${failedInterviews} failed)`;
              }
            }
            return h("tr", {key: d.versionId},
              h("td", {}, h("div", {className: "slds-truncate slds-text-align_center", title: d.versionNumber}, d.versionNumber)),
              h("td", {}, h("div", {className: "slds-truncate slds-text-align_center"}, d.flowDeleted
                ? h("span", {className: "slds-text-color_success"}, "Deleted")
                : h("span", {className: "slds-text-color_error"}, "Failed")
              )),
              h("td", {}, h("div", {className: "slds-truncate slds-text-align_center"}, interviewsLabel)),
              h("td", {}, h("div", {className: "slds-truncate slds-text-align_center", title: d.error || "—"}, d.error || "—"))
            );
          })
        )
      )
    )
    );
  }

  renderFlowInfo() {
    const flow = this.flowScanner?.currentFlow;
    const elements = this.flowScanner?.extractFlowElements() || [];

    return h(FlowInfoSection, {
      flow,
      elements,
      onPurgeVersions: this.onPurgeVersions,
      onWhereUsed: this.onWhereUsed,
      onToggleDescription: this.onToggleDescription,
      handleMouseDown: e => this.handleMouseDown(e),
      shouldIgnoreClick: e => this.shouldIgnoreClick(e)
    });
  }

  renderScanResults() {
    if (!this.flowScanner?.scanResults) {
      return h("div", {className: RESULTS_AREA_CLASS, style: {display: "none"}});
    }
    const results = this.flowScanner.scanResults;

    // Handle unsupported flow type
    const isUnsupported = results.length === 1 && results[0].isUnsupportedFlow;
    if (isUnsupported) {
      const {displayType, supportedFlowTypes, reason} = results[0];

      // Determine the message based on the reason
      let headerMessage, introMessage;
      if (reason === "explicitly_unsupported") {
        headerMessage = `The "${displayType}" flow type is not supported by Flow Scanner.`;
        introMessage = "This flow type is known to be incompatible with the scanner's analysis capabilities.";
      } else {
        headerMessage = `The "${displayType}" flow type is not currently supported.`;
        introMessage = "Flow Scanner works with specific flow types to ensure accurate analysis.";
      }

      return h("div", {className: RESULTS_AREA_CLASS},
        h("div", {className: "unsupported-flow-state"},
          // Header section using empty-state pattern
          h("div", {className: "unsupported-flow-header"},
            h("div", {className: "unsupported-icon-large"}, "⚠️"),
            h("h2", {className: "unsupported-title"}, "Unsupported Flow Type"),
            h("p", {className: "unsupported-subtitle"}, headerMessage),
            h("p", {className: "unsupported-description"}, introMessage)
          ),

          // Supported types section using existing card and list styles
          reason !== "explicitly_unsupported" && h("div", {className: "supported-types-section"},
            h("div", {className: "flow-info-card"},
              h("div", {className: "supported-types-header"},
                h("h3", {},
                  h("span", {style: {marginRight: "8px"}}, "✅"),
                  `${supportedFlowTypes.length} Supported Flow Types`
                ),
                h("p", {}, "Flow Scanner can analyze flows of the following types:")
              ),
              h("ul", {className: "supported-types-list"},
                supportedFlowTypes.map(type =>
                  h("li", {key: type}, type)
                )
              )
            )
          )
        )
      );
    }

    const totalIssues = results.length;
    const severityOrder = ISSUE_SEVERITY_ORDER;
    const severityLabels = {error: "Errors", warning: "Warnings", info: "Info"};
    const accordion = this.state.accordion;
    const groupedResults = this.getGroupedResults();
    const errorCount = groupedResults.error.results.length;
    const warningCount = groupedResults.warning.results.length;
    const infoCount = groupedResults.info.results.length;
    if (totalIssues === 0) {
      // If no rules are enabled, show a warning and prompt to configure them.
      if (this.flowScanner.noRulesEnabledMessage) {
        return h("div", {className: RESULTS_AREA_CLASS},
          h("div", {className: "empty-state"},
            h("div", {className: "empty-icon"}, "⚠️"),
            h("h3", {}, "No Rules Enabled"),
            h("p", {}, this.flowScanner.noRulesEnabledMessage),
            h("button", {className: "slds-button slds-button_brand", onClick: this.onToggleHelp}, "Configure Rules")
          )
        );
      }
      // Default "no issues found" state.
      return h("div", {className: RESULTS_AREA_CLASS},
        h("div", {className: "success-state"},
          h("div", {className: "success-icon"}, "✅"),
          h("h3", {}, "No Issues Found"),
          h("p", {}, "Great job! Your flow passed all checks with no issues detected."),
          h("div", {className: "success-metrics"},
            h("div", {className: "metric-item"},
              h("div", {className: "metric-value", id: "total-issues-count"}, "0"),
              h("div", {className: "metric-label"}, "Issues")
            ),
            h("div", {className: "metric-item"},
              h("div", {className: "metric-value", id: "clean-percentage"}, "100%"),
              h("div", {className: "metric-label"}, "Clean")
            )
          )
        )
      );
    }
    // Summary panel for when issues are found.
    return h("div", {className: RESULTS_AREA_CLASS, "aria-labelledby": "results-title", "aria-live": "polite"},
      h(ScanSummary, {
        totalIssues,
        errorCount,
        warningCount,
        infoCount,
        onExportResults: this.onExportResults,
        onExpandAll: this.onExpandAll,
        onCollapseAll: this.onCollapseAll,
        isStatItemClickable: this.isStatItemClickable.bind(this),
        onStatItemClick: this.onStatItemClick
      }),
      h("div", {className: "results-container", role: "region", "aria-labelledby": "results-title"},
        severityOrder.map(severity => {
          const group = groupedResults[severity].results;
          if (!group.length) return null;
          const rules = groupedResults[severity].rules;
          const sevAccordion = accordion[severity] || {expanded: true, rules: {}};
          const isSevExpanded = sevAccordion.expanded !== false;
          const ruleKeys = Object.keys(rules);
          const expandedRules = ruleKeys.filter(r => sevAccordion.rules && sevAccordion.rules[r]);
          // 1=expanded, 2=mixed, 3=collapsed
          let accordionStateAttr = isSevExpanded ? "1" : "3";
          if (isSevExpanded && expandedRules.length > 0 && expandedRules.length < ruleKeys.length) {
            accordionStateAttr = "2";
          }
          return h("div", {
            key: severity,
            className: `severity-group-layout ${severity}${!isSevExpanded ? " collapsed" : ""}`,
            "data-accordion-state": accordionStateAttr
          },
          h("div", {
            className: "severity-title-left",
            role: "button",
            tabIndex: 0,
            "aria-expanded": isSevExpanded,
            "aria-controls": `${severity}-rules-container`,
            onMouseDown: e => this.handleMouseDown(e),
            onClick: e => { if (this.shouldIgnoreClick(e)) return; this.onSeverityToggle(severity); },
            onKeyDown: e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.onSeverityToggle(severity); } }
          },
          h("h3", {className: "severity-heading"},
            h("div", {className: "severity-heading-content"},
              h("svg", {
                className: "accordion-chevron",
                width: "24",
                height: "24",
                "aria-hidden": "true",
                style: {transform: isSevExpanded ? "rotate(0deg)" : "rotate(-90deg)"}
              },
              h("use", {xlinkHref: "symbols.svg#accordion-chevron"})
              ),
              h("span", {className: "severity-label-group"},
                SEVERITY_ICONS[severity],
                h("span", {}, severityLabels[severity])
              )
            )
          ),
          h("span", {className: "severity-total-count"}, `${group.length} Issue${group.length === 1 ? "" : "s"}`)
          ),
          isSevExpanded && h("div", {className: "rules-container-right", id: `${severity}-rules-container`},
            Object.entries(rules).map(([ruleType, ruleResults], ruleIdx) => {
              const description = ruleResults[0].description || "Rule violation detected";
              const ruleAccordion = sevAccordion.rules || {};
              const ruleExpanded = ruleAccordion[ruleType] !== false;
              return h("div", {
                key: `${severity}-${ruleIdx}`,
                className: `rule-section compact${ruleExpanded ? " expanded" : " collapsed"} card-bg`,
                "data-rule-type": ruleType
              },
              h("div", {
                className: "rule-header",
                tabIndex: 0,
                role: "button",
                "aria-expanded": ruleExpanded,
                "aria-controls": `${severity}-${ruleIdx}-content`,
                onMouseDown: e => this.handleMouseDown(e),
                onClick: e => { if (this.shouldIgnoreClick(e)) return; this.onRuleToggle(severity, ruleType); e.currentTarget.blur(); },
                onKeyDown: e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.onRuleToggle(severity, ruleType); } }
              },
              h("div", {className: "rule-title-section"},
                h("span", {className: "rule-name-compact"}, ruleType),
                h("div", {className: "tooltip-container"},
                  h("svg", {className: "info-icon", "aria-hidden": "true"},
                    h("use", {xlinkHref: "symbols.svg#info"})
                  ),
                  h("div", {className: "tooltip-content"}, description)
                ),
                h("span", {className: "badge-total circle-badge"}, ruleResults.length)
              ),
              h("svg", {
                className: "accordion-chevron",
                width: "24",
                height: "24",
                "aria-hidden": "true",
                style: {transform: ruleExpanded ? "rotate(0deg)" : "rotate(-90deg)"}
              },
              h("use", {xlinkHref: "symbols.svg#accordion-chevron"})
              )
              ),
              h("div", {className: "rule-content", id: `${severity}-${ruleIdx}-content`},
                this.renderRuleTable(ruleResults)
              )
              );
            })
          )
          );
        })
      )
    );
  }

  renderRuleTable(ruleResults) {
    const headers = ["Name", "Element Label", "Type", "Meta", "Connects to", "Location", "Expression"];
    const rows = ruleResults.map(result => {
      const affected = getPrimaryAffectedElement(result);
      return {
        "Name": affected.apiName || affected.elementName || "",
        "Element Label": affected.elementLabel || "",
        "Type": affected.elementType || "",
        "Meta": affected.metaType || "",
        "Connects to": affected.connectsTo || "",
        "Location": (affected.locationX !== undefined && affected.locationY !== undefined && (affected.locationX !== "" || affected.locationY !== "")) ? `(${affected.locationX}, ${affected.locationY})` : "",
        "Expression": affected.expression || ""
      };
    });

    // Determine which columns to show based on whether they contain any data.
    const activeHeaders = headers.filter(header => rows.some(row => row[header]));

    if (activeHeaders.length === 0) {
      return h("div", {}, "No additional details available");
    }

    return h("table", {className: "details-table"},
      h("thead", {},
        h("tr", {},
          activeHeaders.map(header => h("th", {key: header}, header))
        )
      ),
      h("tbody", {},
        rows.map((row, idx) =>
          h("tr", {key: idx},
            activeHeaders.map(header => {
              const cellValue = row[header] || "—";
              const isMono = MONO_HEADERS.has(header);
              const cellClass = isMono ? "mono" : "";
              return h("td", {key: header},
                h("div", {className: `cell-content ${cellClass}`, title: cellValue}, cellValue)
              );
            })
          )
        )
      )
    );
  }

  renderLoadingOverlay() {
    if (!this.state.isLoading) {
      return null;
    }

    return h("div", {
      className: "loading-overlay",
      style: {display: "flex"},
      role: "dialog",
      "aria-labelledby": "loading-title",
      "aria-describedby": "loading-description",
      "aria-modal": "true"
    },
    h("div", {className: "loading-card"},
      h("div", {className: "loading-spinner", "aria-hidden": "true"}),
      h("h3", {id: "loading-title"}, this.state.loadingMessage),
      h("p", {id: "loading-description"}, this.state.loadingDescription)
    )
    );
  }

  renderError() {
    if (!this.state.error) {
      return null;
    }

    return h("div", {className: RESULTS_AREA_CLASS},
      h("div", {className: "empty-state"},
        h("div", {className: "empty-icon"}, "❌"),
        h("h3", {}, "Error Occurred"),
        h("p", {}, this.state.error),
        h("div", {className: "slds-m-top_small"},
          h("button", {
            className: "slds-button slds-button_brand",
            onClick: this.retryAfterError
          }, "Retry")
        )
      )
    );
  }

  render() {
    const sfHost = this.flowScanner?.sfHost || "";
    const sfLink = "https://" + sfHost;
    const scannerVersion = this.flowScanner?.flowScannerCore?.version || "";
    const flow = this.flowScanner?.currentFlow;
    const versionsLength = flow?.versions?.length || 0;
    const maxHistory = versionsLength ? Math.max(0, versionsLength - 1) : 0;

    return h("div", {},
      h(PageHeader, {
        pageTitle: "Flow Scanner",
        orgName: this.state.orgName,
        sfLink,
        sfHost,
        spinnerCount: this.state.isLoading ? 1 : 0,
        userInitials: this.state.userInitials,
        userFullName: this.state.userFullName,
        userName: this.state.userName,
        utilityItems: [
          h("div", {
            key: "core-version",
            className: "slds-builder-header__utilities-item slds-p-top_x-small slds-p-horizontal_x-small"
          },
          h("div", {className: "flow-scanner-note-header"},
            h("small", {},
              "💡 Based on ",
              h("a", {
                href: "https://github.com/flow-scanner/lightning-flow-scanner-core",
                target: getLinkTarget(),
              }, "Lightning Flow Scanner Core"),
              `\u00A0 (core v${scannerVersion})`
            )
          )
          ),
          isOptionEnabled("flow-agentforce", this.state.hideButtonsOption) && h("div", {
            key: "einstiein-btn",
            className: "slds-builder-header__utilities-item slds-p-top_x-small slds-p-horizontal_x-small sfir-border-none"
          },
          h("button", {
            className: "slds-button slds-button_icon slds-button_icon-border-filled",
            title: "Open Agentforce Flow Scanner",
            onClick: this.onToggleAgentforce
          },
          h("svg", {className: "slds-button__icon", "aria-hidden": "true"},
            h("use", {xlinkHref: "symbols.svg#einstein"})
          ))),
          isOptionEnabled("flow-settings", this.state.hideButtonsOption) && h("div", {
            key: "help-btn",
            className: "slds-builder-header__utilities-item slds-p-top_x-small slds-p-horizontal_x-small sfir-border-none"
          },
          h("button", {
            className: "slds-button slds-button_icon slds-button_icon-border-filled",
            title: "Open Flow Scanner Options",
            onClick: this.onToggleHelp
          },
          h("svg", {className: "slds-button__icon", "aria-hidden": "true"},
            h("use", {xlinkHref: "symbols.svg#settings"})
          )
          )
          )
        ]
      }),
      h("div", {className: "slds-m-top_xx-large"},
        h("div", {className: "main-content-wrapper"},
          this.renderFlowInfo(),
          this.state.error ? this.renderError() : this.renderScanResults()
        )
      ),
      this.renderLoadingOverlay(),
      this.renderPurgeResultModal(),
      h(AgentforceModal, {
        isOpen: this.state.showAgentforceModal,
        onClose: this.onAgentforceClose,
        onSend: this.onAgentforceSend,
        prompt: this.state.agentforcePrompt,
        onPromptChange: this.onAgentforcePromptChange,
        analysisResult: this.state.agentforceAnalysis,
        error: this.state.agentforceError
      }),
      h(PurgeModal, {
        isOpen: this.state.showPurgeModal,
        purgeHistorySize: this.state.purgeHistorySize,
        purgeDetails: this.state.purgeDetails,
        purgeWarning: this.state.purgeWarning,
        maxHistory,
        onConfirm: this.confirmPurge,
        onCancel: this.cancelPurge,
        onHistorySizeChange: this.onPurgeHistorySizeChange
      }),
      h(WhereUsedModal, {
        isOpen: this.state.showWhereUsedModal,
        onClose: this.onWhereUsedClose,
        onSearch: this.onWhereUsedSearch,
        referencingFlows: this.state.referencingFlows,
        isLoading: this.state.whereUsedLoading,
        error: this.state.whereUsedError,
        sfHost,
        progress: this.state.whereUsedProgress,
        hasSearched: this.state.whereUsedHasSearched,
        filterMode: this.state.whereUsedFilterMode,
        onFilterModeChange: this.onWhereUsedFilterModeChange,
        scanMode: this.state.whereUsedScanMode,
        onScanModeChange: this.onWhereUsedScanModeChange,
        versionScope: this.state.whereUsedVersionScope,
        onVersionScopeChange: this.onWhereUsedVersionScopeChange,
        statusFilters: this.state.whereUsedStatusFilters,
        onStatusFilterToggle: this.onWhereUsedStatusFilterToggle
      }),
      h("div", {className: "sr-only", "aria-live": "polite", "aria-atomic": "true", id: "sr-announcements"})
    );
  }
}

const MONO_HEADERS = new Set(["Name", "Connects to", "Expression", "Location"]);
const ISSUE_SEVERITY_ORDER = ["error", "warning", "info"];
const RESULTS_AREA_CLASS = "area scan-results-area";
const SEVERITY_ICONS = {
  error: h("span", {className: "sev-ico error", "aria-label": "Error"}, "❗"),
  warning: h("span", {className: "sev-ico warning", "aria-label": "Warning"}, "⚠️"),
  info: h("span", {className: "sev-ico info", "aria-label": "Info"}, "ℹ️")
};

// Initialize the application
{
  let root = document.getElementById("root");

  // eslint-disable-next-line react/no-deprecated
  ReactDOM.render(h(App), root);

  if (parent && parent.isUnitTest) {
    parent.insextTestLoaded({sfConn});
  }
}
