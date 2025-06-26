import {sfConn, apiVersion} from "./inspector.js";
/* global initButton lightningflowscanner */

// Debug script loading
console.log("Flow Scanner Core script loaded");
console.log("Available global variables after loading:", Object.keys(window).filter(key => key.toLowerCase().includes("flow")));
if (typeof lightningflowscanner !== "undefined") {
  console.log("lightningflowscanner found:", lightningflowscanner);
}

class FlowScanner {
  constructor(sfHost, flowDefId, flowId) {
    console.log("FlowScanner constructor called with:", {sfHost, flowDefId, flowId});
    this.sfHost = sfHost;
    this.flowDefId = flowDefId;
    this.flowId = flowId;
    this.currentFlow = null;
    this.scanResults = [];
    this.flowScannerCore = null;
    this.isScanning = false;

    console.log("FlowScanner instance created, calling init()");
    this.init();
  }

  init() {
    console.log("FlowScanner init() called");
    this.initFlowScannerCore();
    this.bindEvents();
    this.loadFlowInfo();
  }

  initFlowScannerCore() {
    try {
      console.log("Initializing Flow Scanner Core...");

      // Only use lightningflowscanner - no fallbacks
      if (typeof lightningflowscanner !== "undefined") {
        console.log("Flow Scanner Core found as lightningflowscanner, creating instance");
        this.flowScannerCore = lightningflowscanner;
        console.log("Flow Scanner Core loaded successfully");
      } else {
        console.error("Flow Scanner Core (lightningflowscanner) not available");
        this.flowScannerCore = null;
        throw new Error("Flow Scanner Core library not loaded. Please ensure flow-scanner-core.js is properly included.");
      }
    } catch (error) {
      console.error("Error initializing Flow Scanner Core:", error);
      this.flowScannerCore = null;
      throw error;
    }
  }

  bindEvents() {
    document.getElementById("scan-button").addEventListener("click", () => {
      this.scanFlow();
    });
    document.getElementById("export-button").addEventListener("click", () => {
      this.exportResults();
    });
    document.getElementById("close-button").addEventListener("click", () => {
      this.closeOverlay();
    });
  }

  async loadFlowInfo() {
    console.log("Loading flow info...");
    try {
      if (!this.flowDefId || !this.flowId) {
        this.showError("No flow information found in URL");
        return;
      }
      const flowInfo = await this.getFlowMetadata();
      console.log("Flow info loaded:", flowInfo);
      this.currentFlow = flowInfo;
      this.displayFlowInfo(flowInfo);
    } catch (error) {
      console.error("Error loading flow info:", error);
      this.showError("Failed to load flow information: " + error.message);
    }
  }

  async getFlowMetadata() {
    try {
      console.log("Fetching flow metadata for:", {flowId: this.flowId, flowDefId: this.flowDefId});

      // Add cache-busting parameter to force fresh queries
      const cacheBuster = Math.random();

      // Use the correct Tooling API format with only valid fields
      const [flowRes, flowDefRes] = await Promise.all([
        sfConn.rest(`/services/data/v${apiVersion}/tooling/query?q=SELECT+Id,Metadata+FROM+Flow+WHERE+Id='${this.flowId}'&cache=${cacheBuster}`),
        sfConn.rest(`/services/data/v${apiVersion}/tooling/query?q=SELECT+Id,DeveloperName,MasterLabel+FROM+FlowDefinition+WHERE+Id='${this.flowDefId}'&cache=${cacheBuster}`)
      ]);

      console.log("Flow API response:", flowRes);
      console.log("FlowDefinition API response:", flowDefRes);

      const flowRecord = flowRes.records?.[0];
      const flowDefRecord = flowDefRes.records?.[0];

      console.log("Flow record:", flowRecord);
      console.log("FlowDefinition record:", flowDefRecord);

      if (!flowRecord || !flowDefRecord) {
        throw new Error("Flow or FlowDefinition not found");
      }

      // Extract flow type and status from the Flow metadata
      const flowType = flowRecord.Metadata?.processType || "Unknown";
      const flowStatus = flowRecord.Metadata?.status || "Unknown";

      console.log("Extracted flow type:", flowType);
      console.log("Extracted flow status:", flowStatus);

      const result = {
        id: this.flowId,
        definitionId: this.flowDefId,
        name: flowDefRecord.DeveloperName || flowDefRecord.MasterLabel || "Unknown Flow",
        type: flowType,
        status: flowStatus,
        xmlData: flowRecord.Metadata
      };

      console.log("Final flow metadata result:", result);
      console.log("Result values:", {
        id: result.id,
        definitionId: result.definitionId,
        name: result.name,
        type: result.type,
        status: result.status
      });
      console.log("FLOW NAME:", result.name);
      console.log("FLOW TYPE:", result.type);
      console.log("FLOW STATUS:", result.status);
      return result;
    } catch (error) {
      console.error("Error getting flow metadata:", error);
      throw new Error("Failed to fetch flow metadata: " + error.message);
    }
  }

  displayFlowInfo(flowInfo) {
    console.log("Displaying detailed flow info:", flowInfo);

    const nameElement = document.getElementById("flow-name");
    const typeElement = document.getElementById("flow-type");
    const statusElement = document.getElementById("flow-status-text");
    const statusBadge = document.getElementById("flow-status-badge");
    const apiVersionElement = document.getElementById("flow-api-version");
    const descriptionElement = document.getElementById("flow-description");
    const elementsCountElement = document.getElementById("flow-elements-count");

    console.log("DOM elements found:", {
      nameElement: !!nameElement,
      typeElement: !!typeElement,
      statusElement: !!statusElement,
      statusBadge: !!statusBadge,
      apiVersionElement: !!apiVersionElement,
      descriptionElement: !!descriptionElement,
      elementsCountElement: !!elementsCountElement
    });

    if (nameElement) nameElement.textContent = flowInfo.name;
    if (typeElement) typeElement.textContent = flowInfo.type;

    // Update status with badge styling
    if (statusElement && statusBadge) {
      statusElement.textContent = flowInfo.status;

      // Remove existing status classes
      statusBadge.className = "flow-status-badge";

      // Add status-specific styling
      const statusLower = flowInfo.status.toLowerCase();
      if (statusLower === "active") {
        statusBadge.classList.add("active");
      } else if (statusLower === "draft") {
        statusBadge.classList.add("draft");
      } else if (statusLower === "inactive") {
        statusBadge.classList.add("inactive");
      }
    }

    if (apiVersionElement) {
      const apiVersion = flowInfo.xmlData?.apiVersion || "Unknown";
      apiVersionElement.textContent = apiVersion;
    }

    if (descriptionElement) {
      const description = flowInfo.xmlData?.description || "No description provided";
      descriptionElement.textContent = description;
      if (!flowInfo.xmlData?.description) {
        descriptionElement.style.fontStyle = "italic";
        descriptionElement.style.color = "#6c757d";
      }
    }

    if (elementsCountElement) {
      const elements = this.extractFlowElements();
      elementsCountElement.textContent = elements.length;
    }

    // Check if the DOM was actually updated
    setTimeout(() => {
      console.log("DOM after update:", {
        nameText: nameElement?.textContent,
        typeText: typeElement?.textContent,
        statusText: statusElement?.textContent,
        apiVersionText: apiVersionElement?.textContent,
        descriptionText: descriptionElement?.textContent,
        elementsCountText: elementsCountElement?.textContent
      });
    }, 100);

    console.log("Values being set:", {
      name: flowInfo.name,
      type: flowInfo.type,
      status: flowInfo.status,
      apiVersion: flowInfo.xmlData?.apiVersion,
      description: flowInfo.xmlData?.description,
      elementsCount: this.extractFlowElements().length
    });

    console.log("Detailed flow info displayed on UI:", {
      name: flowInfo.name,
      type: flowInfo.type,
      status: flowInfo.status,
      apiVersion: flowInfo.xmlData?.apiVersion,
      description: flowInfo.xmlData?.description,
      elementsCount: this.extractFlowElements().length
    });
  }

  async scanFlow() {
    console.log("scanFlow() called with currentFlow:", this.currentFlow);

    if (!this.currentFlow) {
      this.showError("No flow loaded");
      return;
    }

    this.isScanning = true;
    this.showLoading(true);
    try {
      // Force re-initialization of Flow Scanner Core
      console.log("Re-initializing Flow Scanner Core...");
      this.initFlowScannerCore();

      // Use Flow Scanner Core for detailed analysis - no fallbacks
      if (!this.flowScannerCore) {
        throw new Error("Flow Scanner Core library not available");
      }

      console.log("Flow Scanner Core is available, using it for analysis");
      console.log("Flow Scanner Core object:", this.flowScannerCore);
      console.log("Flow Scanner Core methods:", Object.getOwnPropertyNames(this.flowScannerCore));

      const results = await this.scanWithCore();

      console.log("Scan completed with results:", results);
      this.scanResults = results;
      this.displayResults(results);
      this.updateExportButton();
    } catch (error) {
      console.error("Error scanning flow:", error);
      this.showError("Failed to scan flow: " + error.message);
    } finally {
      this.isScanning = false;
      this.showLoading(false);
    }
  }

  async scanWithCore() {
    try {
      console.log("Starting scanWithCore with flow data:", this.currentFlow);
      console.log("Flow status:", this.currentFlow.status);
      console.log("Flow type:", this.currentFlow.type);

      if (!this.currentFlow || !this.currentFlow.xmlData) {
        console.error("No flow data available for scanning");
        return [{
          rule: "Scan Error",
          description: "No flow data available for scanning",
          severity: "error",
          details: "Flow data is missing or incomplete"
        }];
      }

      // Create a Flow object from the metadata
      const flowData = {
        Flow: this.currentFlow.xmlData
      };

      // Create a Flow object using the Flow Scanner Core's Flow class
      const flow = new this.flowScannerCore.Flow("virtual-flow.xml", flowData);

      // Create a ParsedFlow object
      const parsedFlow = new this.flowScannerCore.ParsedFlow("virtual-flow.xml", flow);

      console.log("Created flow object for core scanner:", flow);
      console.log("Flow elements count:", flow.elements?.length || 0);
      console.log("Flow name:", flow.name);
      console.log("Flow type:", flow.type);
      console.log("Flow status:", flow.status);

      // Use the scan method from Flow Scanner Core with ParsedFlow array
      console.log("Calling flowScannerCore.scan with parsed flow");
      const scanResults = this.flowScannerCore.scan([parsedFlow]);
      console.log("Flow Scanner Core returned results:", scanResults);
      console.log("Scan results type:", typeof scanResults);
      console.log("Scan results length:", scanResults?.length);
      console.log("Full scan results structure:", JSON.stringify(scanResults, null, 2));

      const results = [];

      // Process each flow result
      for (const flowResult of scanResults) {
        console.log("Processing flow result:", flowResult);
        console.log("Flow result structure:", JSON.stringify(flowResult, null, 2));

        if (flowResult.errorMessage) {
          console.error("Flow scan error:", flowResult.errorMessage);
          results.push({
            rule: "Scan Error",
            description: "Failed to scan flow: " + flowResult.errorMessage,
            severity: "error",
            details: "Flow: " + this.currentFlow.name
          });
          continue;
        }

        // Check different possible result structures
        const ruleResults = flowResult.ruleResults || flowResult.results || flowResult.issues || [];
        console.log("Rule results found:", ruleResults);
        console.log("Rule results length:", ruleResults.length);

        // Process each rule result
        for (const ruleResult of ruleResults) {
          console.log("Processing rule result:", ruleResult);
          console.log("Rule result structure:", JSON.stringify(ruleResult, null, 2));

          // Skip rules that don't have any violations (occurs: false)
          if (!ruleResult.occurs) {
            console.log("Skipping rule with no violations:", ruleResult.ruleName);
            continue;
          }

          // Get rule description from rule definition
          const ruleDescription = ruleResult.ruleDefinition?.description || "No description available";
          const ruleLabel = ruleResult.ruleDefinition?.label || ruleResult.ruleName;

          // Process each violation detail
          if (ruleResult.details && ruleResult.details.length > 0) {
            for (const detail of ruleResult.details) {
              console.log("Processing violation detail:", detail);

              // Extract element information from the violation
              const elementName = detail.name || detail.violation?.name || "Unknown";
              const elementType = detail.type || detail.violation?.subtype || "Unknown";
              const metaType = detail.metaType || detail.violation?.metaType || "";
              const dataType = detail.dataType || "";
              const locationX = detail.details?.locationX || detail.violation?.locationX || "";
              const locationY = detail.details?.locationY || detail.violation?.locationY || "";
              const connectsTo = detail.details?.connectsTo || "";
              const expression = detail.details?.expression || detail.violation?.expression || "";

              // Convert rule result to our format
              const result = {
                rule: ruleLabel,
                description: ruleDescription,
                severity: this.mapSeverity(ruleResult.severity),
                details: this.formatRuleDetails({
                  elementName,
                  elementType,
                  metaType,
                  dataType,
                  locationX,
                  locationY,
                  connectsTo,
                  expression
                }),
                // Add additional fields for export
                ruleDescription,
                ruleLabel,
                flowName: this.currentFlow.name,
                name: elementName,
                type: elementType,
                metaType,
                dataType,
                locationX,
                locationY,
                connectsTo,
                expression
              };

              console.log("Converted result:", result);
              results.push(result);
            }
          } else {
            // Handle rules with no specific details but still have violations
            const result = {
              rule: ruleLabel,
              description: ruleDescription,
              severity: this.mapSeverity(ruleResult.severity),
              details: "Rule violation detected",
              // Add additional fields for export
              ruleDescription,
              ruleLabel,
              flowName: this.currentFlow.name,
              name: "Flow Level",
              type: "Flow",
              metaType: "",
              dataType: "",
              locationX: "",
              locationY: "",
              connectsTo: "",
              expression: ""
            };

            console.log("Converted result (no details):", result);
            results.push(result);
          }
        }
      }

      console.log("Final processed results:", results);
      console.log("Results count:", results.length);
      return results;

    } catch (error) {
      console.error("Error in scanWithCore:", error);
      console.error("Error stack:", error.stack);
      return [{
        rule: "Scan Error",
        description: "Failed to scan flow with Flow Scanner Core: " + error.message,
        severity: "error",
        details: "Flow: " + this.currentFlow.name
      }];
    }
  }

  mapSeverity(coreSeverity) {
    // Map Flow Scanner Core severity to our format
    switch (coreSeverity?.toLowerCase()) {
      case "error":
      case "critical":
        return "error";
      case "warning":
        return "warning";
      case "info":
      case "information":
        return "info";
      default:
        return "info";
    }
  }

  formatRuleDetails(ruleResult) {
    const details = [];

    if (ruleResult.elementName) {
      details.push(`Element: ${ruleResult.elementName}`);
    }

    if (ruleResult.elementType) {
      details.push(`Type: ${ruleResult.elementType}`);
    }

    if (ruleResult.metaType) {
      details.push(`Meta Type: ${ruleResult.metaType}`);
    }

    if (ruleResult.dataType) {
      details.push(`Data Type: ${ruleResult.dataType}`);
    }

    if (ruleResult.locationX && ruleResult.locationY) {
      details.push(`Location: (${ruleResult.locationX}, ${ruleResult.locationY})`);
    }

    if (ruleResult.connectsTo) {
      details.push(`Connects to: ${ruleResult.connectsTo}`);
    }

    if (ruleResult.expression) {
      details.push(`Expression: ${ruleResult.expression}`);
    }

    return details.join(" | ");
  }

  extractFlowElements() {
    if (!this.currentFlow || !this.currentFlow.xmlData) {
      console.log("No flow data available for element extraction");
      return [];
    }

    const elements = [];
    const xmlData = this.currentFlow.xmlData;

    // Extract all possible flow elements from the metadata
    const elementTypes = [
      "actionCalls",
      "assignments",
      "collectionProcessors",
      "decisions",
      "faultPaths",
      "formulas",
      "loops",
      "recordCreates",
      "recordDeletes",
      "recordLookups",
      "recordUpdates",
      "screens",
      "start",
      "subflows",
      "switches",
      "waits",
      "transforms",
      "customErrors",
      "apexPluginCalls",
      "steps",
      "orchestratedStages",
      "recordRollbacks"
    ];

    elementTypes.forEach(elementType => {
      if (xmlData[elementType]) {
        if (Array.isArray(xmlData[elementType])) {
          xmlData[elementType].forEach(element => {
            elements.push({
              name: element.name || element.label || element.apiName || "Unknown",
              type: elementType,
              element
            });
          });
        } else if (typeof xmlData[elementType] === "object") {
          // Handle single elements that are objects
          const element = xmlData[elementType];
          elements.push({
            name: element.name || element.label || element.apiName || elementType,
            type: elementType,
            element
          });
        }
      }
    });

    // Also check for individual elements that might not be in arrays
    if (xmlData.start && typeof xmlData.start === "object") {
      elements.push({
        name: xmlData.start.name || "Start",
        type: "start",
        element: xmlData.start
      });
    }

    console.log(`Extracted ${elements.length} flow elements:`, elements.map(e => `${e.type}: ${e.name}`));
    return elements;
  }

  displayResults(results) {
    const container = document.getElementById("results-container");
    const resultsSection = document.getElementById("results-section");
    const elementsSection = document.getElementById("elements-section");
    const totalIssues = document.getElementById("total-issues");
    const errorCount = document.getElementById("error-count");
    const warningCount = document.getElementById("warning-count");
    const infoCount = document.getElementById("info-count");

    // Show the results and elements sections
    resultsSection.style.display = "block";
    elementsSection.style.display = "block";

    totalIssues.textContent = results.length;

    // Calculate severity breakdown
    const errorCountNum = results.filter(r => r.severity === "error").length;
    const warningCountNum = results.filter(r => r.severity === "warning").length;
    const infoCountNum = results.filter(r => r.severity === "info").length;

    if (errorCount) errorCount.textContent = errorCountNum;
    if (warningCount) warningCount.textContent = warningCountNum;
    if (infoCount) infoCount.textContent = infoCountNum;

    if (results.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">✅</div>
          <h3>No Issues Found!</h3>
          <p>Great job! Your flow looks good and follows best practices.</p>
        </div>
      `;
      return;
    }

    // Group results by severity first, then by rule type
    const severityGroups = {
      error: [],
      warning: [],
      info: []
    };
    results.forEach(result => {
      if (severityGroups[result.severity]) {
        severityGroups[result.severity].push(result);
      }
    });
    let resultsHTML = "";
    let firstSection = true;
    Object.entries(severityGroups).forEach(([severity, severityResults]) => {
      if (severityResults.length === 0) return;
      const severityIcons = {error: "❌", warning: "⚠️", info: "ℹ️"};
      const severityLabels = {error: "Errors", warning: "Warnings", info: "Information"};
      const sectionId = `accordion-${severity}`;
      const expanded = firstSection ? "expanded" : "collapsed";
      const ariaExpanded = firstSection ? "true" : "false";
      resultsHTML += `
        <div class="severity-section ${expanded}" data-severity="${severity}">
          <div class="severity-title ${severity}" tabindex="0" role="button" aria-expanded="${ariaExpanded}" aria-controls="${sectionId}" data-accordion-toggle="true">
            <span class="accordion-chevron">▼</span>
            <span class="severity-label">${severityIcons[severity]} ${severityLabels[severity]}</span>
            <span class="issue-count">${severityResults.length}</span>
          </div>
          <div class="accordion-content" id="${sectionId}">
      `;
      // Group by rule within each severity
      const ruleGroups = {};
      severityResults.forEach(result => {
        const ruleKey = result.rule;
        if (!ruleGroups[ruleKey]) {
          ruleGroups[ruleKey] = {
            rule: result.rule,
            description: result.description,
            severity: result.severity,
            elements: []
          };
        }
        ruleGroups[ruleKey].elements.push(result);
      });
      if (Object.keys(ruleGroups).length === 0) {
        resultsHTML += "<div class=\"empty-state\"><div class=\"empty-icon\">✅</div><h3>No issues in this section</h3></div>";
      } else {
        Object.values(ruleGroups).forEach(ruleGroup => {
          const severityIcon = severityIcons[ruleGroup.severity];
          resultsHTML += `
            <div class="issue-item">
              <div class="issue-header">
                <h3 class="issue-title">${severityIcon} ${ruleGroup.rule}</h3>
                <span class="issue-severity ${ruleGroup.severity}">${ruleGroup.severity.toUpperCase()}</span>
              </div>
              <div class="issue-description">
                ${ruleGroup.description}
              </div>
              <div class="affected-elements">
                <h5>Affected Elements (${ruleGroup.elements.length})</h5>
                ${ruleGroup.elements.map(element => this.createElementDetailHTML(element)).join("")}
              </div>
            </div>
          `;
        });
      }
      resultsHTML += `
          </div>
        </div>
      `;
      firstSection = false;
    });
    container.innerHTML = resultsHTML;
    this.bindAccordionEvents();
    this.displayFlowElements();
  }

  createElementDetailHTML(element) {
    const details = [];

    if (element.type && element.type !== "Unknown") {
      details.push(`<strong>Type:</strong> ${element.type}`);
    }

    if (element.metaType) {
      details.push(`<strong>Meta Type:</strong> ${element.metaType}`);
    }

    if (element.dataType) {
      details.push(`<strong>Data Type:</strong> ${element.dataType}`);
    }

    if (element.locationX && element.locationY) {
      details.push(`<strong>Location:</strong> (${element.locationX}, ${element.locationY})`);
    }

    if (element.connectsTo) {
      details.push(`<strong>Connects to:</strong> ${element.connectsTo}`);
    }

    if (element.expression) {
      details.push(`<strong>Expression:</strong> ${element.expression}`);
    }

    return `
      <div class="element-detail">
        <div class="element-name">${element.name}</div>
        ${details.length > 0 ? `<div class="element-info">${details.join(" | ")}</div>` : ""}
      </div>
    `;
  }

  displayFlowElements() {
    const container = document.getElementById("elements-container");
    if (!container) return;

    const elements = this.extractFlowElements();

    if (elements.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🧩</div>
          <h3>No Flow Elements Found</h3>
          <p>Unable to extract flow elements. Please try scanning the flow again.</p>
        </div>
      `;
      return;
    }

    // Group elements by type
    const elementGroups = {};
    elements.forEach(element => {
      if (!elementGroups[element.type]) {
        elementGroups[element.type] = [];
      }
      elementGroups[element.type].push(element);
    });

    let elementsHTML = '<div class="elements-summary">';
    elementsHTML += `<p>Found <strong>${elements.length}</strong> flow elements across <strong>${Object.keys(elementGroups).length}</strong> types:</p>`;
    elementsHTML += "</div>";

    elementsHTML += '<div class="elements-breakdown">';
    Object.keys(elementGroups).sort().forEach(type => {
      const typeElements = elementGroups[type];
      elementsHTML += "<div class=\"element-type-group\">";
      elementsHTML += "<div class=\"element-type-title\">";
      elementsHTML += "<span>" + type + "</span>";
      elementsHTML += "<span class=\"element-type-count\">" + typeElements.length + "</span>";
      elementsHTML += "</div>";
      elementsHTML += '<div class="element-list">';
      typeElements.forEach(element => {
        elementsHTML += `<div class="element-item">${element.name}</div>`;
      });
      elementsHTML += "</div>";
      elementsHTML += "</div>";
    });
    elementsHTML += "</div>";

    container.innerHTML = elementsHTML;
  }

  updateExportButton() {
    const exportBtn = document.getElementById("export-button");
    exportBtn.disabled = this.scanResults.length === 0;
  }

  exportResults() {
    if (this.scanResults.length === 0) {
      return;
    }

    // Create CSV export with detailed fields
    const csvHeaders = [
      "ruleDescription",
      "ruleLabel",
      "flowName",
      "name",
      "type",
      "metaType",
      "dataType",
      "locationX",
      "locationY",
      "connectsTo",
      "expression"
    ];

    const csvRows = [csvHeaders.join(",")];

    this.scanResults.forEach(result => {
      const row = csvHeaders.map(header => {
        const value = result[header] || "";
        // Escape quotes and wrap in quotes if contains comma or quote
        const escapedValue = value.toString().replace(/"/g, '""');
        return `"${escapedValue}"`;
      });
      csvRows.push(row.join(","));
    });

    const csvContent = csvRows.join("\n");
    const blob = new Blob([csvContent], {type: "text/csv"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `flow-scan-${this.currentFlow.name}-${new Date().toISOString().split("T")[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  showLoading(show) {
    const overlay = document.getElementById("loading-overlay");
    overlay.style.display = show ? "flex" : "none";
  }

  showError(message) {
    const container = document.getElementById("results-container");
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">❌</div>
        <h3>Error Occurred</h3>
        <p>${message}</p>
      </div>
    `;
  }

  closeOverlay() {
    // Send message to parent to close the overlay
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({
        command: "closeFlowScannerOverlay"
      }, "*");
    }
  }

  bindAccordionEvents() {
    const accordionToggles = document.querySelectorAll('[data-accordion-toggle="true"]');
    accordionToggles.forEach(toggle => {
      toggle.addEventListener("click", () => {
        const section = toggle.closest(".severity-section");
        if (section) {
          this.toggleAccordion(section);
        }
      });
      toggle.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          const section = toggle.closest(".severity-section");
          if (section) {
            this.toggleAccordion(section);
          }
        }
      });
    });
  }

  toggleAccordion(section) {
    const title = section.querySelector(".severity-title");
    const expanded = section.classList.contains("expanded");

    if (expanded) {
      section.classList.remove("expanded");
      section.classList.add("collapsed");
      if (title) title.setAttribute("aria-expanded", "false");
    } else {
      section.classList.remove("collapsed");
      section.classList.add("expanded");
      if (title) title.setAttribute("aria-expanded", "true");
    }
  }
}

async function init() {
  const params = new URLSearchParams(window.location.search);
  const sfHost = params.get("host");
  const flowDefId = params.get("flowDefId");
  const flowId = params.get("flowId");

  console.log("Flow Scanner init with params:", {sfHost, flowDefId, flowId});

  // Initialize the button (for consistent UI)
  initButton(sfHost, true);

  // Get session and initialize flow scanner
  try {
    console.log("Getting session for:", sfHost);
    await sfConn.getSession(sfHost);
    console.log("Session established successfully");

    console.log("Creating FlowScanner instance");
    window.flowScanner = new FlowScanner(sfHost, flowDefId, flowId);
    console.log("FlowScanner instance created:", window.flowScanner);
  } catch (error) {
    console.error("Failed to initialize Flow Scanner:", error);
    document.getElementById("results-container").innerHTML
      = '<div class="no-results" style="color: #c62828;">Error: Failed to authenticate with Salesforce. Please refresh the page and try again.</div>';
  }
}

document.addEventListener("DOMContentLoaded", init);
