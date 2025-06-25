// Flow Scanner for Salesforce Inspector
import {sfConn, apiVersion} from "./inspector.js";
/* global initButton */

class FlowScanner {
  constructor(sfHost, flowDefId, flowId) {
    this.sfHost = sfHost;
    this.flowDefId = flowDefId;
    this.flowId = flowId;
    this.currentFlow = null;
    this.scanResults = [];
    this.flowScannerCore = null;
    this.init();
  }

  init() {
    this.bindEvents();
    this.loadFlowInfo();
    this.initFlowScannerCore();
  }

  initFlowScannerCore() {
    // Check if Flow Scanner Core is available
    if (typeof lightningflowscanner !== 'undefined') {
      this.flowScannerCore = lightningflowscanner;
      console.log('Flow Scanner Core loaded successfully');
    } else {
      console.warn('Flow Scanner Core not available, using basic analysis');
    }
  }

  bindEvents() {
    document.getElementById('scan-button').addEventListener('click', () => {
      this.scanFlow();
    });

    document.getElementById('export-button').addEventListener('click', () => {
      this.exportResults();
    });
  }

  async loadFlowInfo() {
    try {
      if (!this.flowDefId || !this.flowId) {
        this.showError('No flow information found in URL');
        return;
      }

      // Get flow metadata from Salesforce
      const flowInfo = await this.getFlowMetadata(this.flowDefId, this.flowId);
      this.currentFlow = flowInfo;
      this.displayFlowInfo(flowInfo);
    } catch (error) {
      console.error('Error loading flow info:', error);
      this.showError('Failed to load flow information');
    }
  }

  async getFlowMetadata(flowDefId, flowId) {
    try {
      const res = await sfConn.rest(
        `/services/data/v${apiVersion}/tooling/sobjects/Flow/${flowId}`,
        {method: 'GET'}
      );

      return {
        id: flowId,
        definitionId: flowDefId,
        name:
          res.FullName || res.MasterLabel || this.extractFlowNameFromPage(),
        type: res.ProcessType || this.extractFlowTypeFromPage(),
        status: res.Status || this.extractFlowStatusFromPage(),
        xmlData: res.Metadata
      };
    } catch (error) {
      console.error('Error getting flow metadata:', error);
      return {
        id: flowId,
        definitionId: flowDefId,
        name: this.extractFlowNameFromPage() || 'Unknown Flow',
        type: this.extractFlowTypeFromPage() || 'Unknown',
        status: this.extractFlowStatusFromPage() || 'Unknown',
        xmlData: null
      };
    }
  }

  extractFlowNameFromPage() {
    // Try to extract flow name from various page elements
    const titleElement = document.querySelector('title');
    if (titleElement && titleElement.textContent.includes('Flow Builder')) {
      return titleElement.textContent.replace(' - Flow Builder', '').trim();
    }

    const headerElement = document.querySelector('h1, .slds-page-header__title');
    if (headerElement) {
      return headerElement.textContent.trim();
    }

    return 'Unknown Flow';
  }

  extractFlowTypeFromPage() {
    // Try to extract flow type from page content
    const pageContent = document.body.textContent;
    if (pageContent.includes('Auto-launched Flow')) return 'AutoLaunchedFlow';
    if (pageContent.includes('Screen Flow')) return 'Flow';
    if (pageContent.includes('Process Builder')) return 'Workflow';
    if (pageContent.includes('Invocable Process')) return 'InvocableProcess';
    
    return 'Flow';
  }

  extractFlowStatusFromPage() {
    // Try to extract flow status from page content
    const pageContent = document.body.textContent;
    if (pageContent.includes('Active')) return 'Active';
    if (pageContent.includes('Draft')) return 'Draft';
    if (pageContent.includes('Inactive')) return 'Inactive';
    
    return 'Unknown';
  }

  async getFlowXML(flowId) {
    try {
      const res = await sfConn.rest(
        `/services/data/v${apiVersion}/tooling/sobjects/Flow/${flowId}`,
        {method: 'GET'}
      );
      return res.Metadata;
    } catch (error) {
      console.error('Error fetching flow XML:', error);
      return this.extractFlowXMLFromPage();
    }
  }


  extractFlowXMLFromPage() {
    // Fallback method to extract flow data from page
    return {
      processType: this.extractFlowTypeFromPage(),
      status: this.extractFlowStatusFromPage(),
      label: this.extractFlowNameFromPage(),
      apiVersion: '58.0'
    };
  }

  displayFlowInfo(flowInfo) {
    document.getElementById('flow-name').textContent = flowInfo.name;
    document.getElementById('flow-type').textContent = `Type: ${flowInfo.type}`;
    document.getElementById('flow-status').textContent = `Status: ${flowInfo.status}`;
  }

  async scanFlow() {
    if (!this.currentFlow) {
      this.showError('No flow loaded');
      return;
    }

    this.showLoading(true);
    
    try {
      let results = [];
      
      if (this.flowScannerCore) {
        // Use Flow Scanner Core for comprehensive analysis
        results = await this.scanWithCore();
      } else {
        // Fallback to basic analysis
        results = await this.analyzeFlow(this.currentFlow);
      }
      
      this.scanResults = results;
      this.displayResults(results);
      this.updateExportButton();
    } catch (error) {
      console.error('Error scanning flow:', error);
      this.showError('Failed to scan flow: ' + error.message);
    } finally {
      this.showLoading(false);
    }
  }

  async scanWithCore() {
    try {
      // Create a mock flow object that the core can analyze
      const mockFlow = {
        name: this.currentFlow.name,
        type: this.currentFlow.type,
        xmldata: this.currentFlow.xmlData,
        elements: this.extractFlowElements()
      };

      // Use the Flow Scanner Core to analyze the flow
      const parsedFlows = [{
        uri: this.currentFlow.id,
        flow: mockFlow,
        errorMessage: null
      }];

      const scanResults = this.flowScannerCore.scan(parsedFlows);
      
      // Convert core results to our format
      const results = [];
      for (const scanResult of scanResults) {
        for (const ruleResult of scanResult.ruleResults) {
          if (ruleResult.occurs && ruleResult.details && ruleResult.details.length > 0) {
            for (const detail of ruleResult.details) {
              results.push({
                rule: ruleResult.ruleName,
                description: ruleResult.ruleDefinition?.description || ruleResult.ruleName,
                severity: ruleResult.severity || 'warning',
                details: `Flow: ${this.currentFlow.name} - ${detail.name || 'Unknown element'}`
              });
            }
          }
        }
      }

      return results;
    } catch (error) {
      console.error('Error with Flow Scanner Core:', error);
      // Fallback to basic analysis
      return await this.analyzeFlow(this.currentFlow);
    }
  }

  extractFlowElements() {
    // Extract flow elements from the current page context
    // This is a simplified approach - in a real implementation,
    // you'd want to parse the actual flow XML
    return [];
  }

  async analyzeFlow(flow) {
    const results = [];
    
    // Basic flow analysis rules
    const rules = [
      {
        name: 'Flow Description',
        description: 'Flow should have a description for better documentation',
        severity: 'warning',
        check: (flow) => !flow.xmlData?.description
      },
      {
        name: 'API Version',
        description: 'Flow should use a recent API version',
        severity: 'info',
        check: (flow) => {
          const apiVersion = flow.xmlData?.apiVersion;
          if (!apiVersion) return true;
          const version = parseFloat(apiVersion);
          return version < 58.0;
        }
      },
      {
        name: 'Flow Status',
        description: 'Active flows should be thoroughly tested',
        severity: 'info',
        check: (flow) => flow.status === 'Active'
      },
      {
        name: 'Flow Type Check',
        description: 'Consider using Flow instead of Process Builder for new automation',
        severity: 'warning',
        check: (flow) => flow.type === 'Workflow'
      },
      {
        name: 'Flow Name Convention',
        description: 'Flow names should follow naming conventions',
        severity: 'info',
        check: (flow) => {
          const name = flow.name || '';
          return !name.includes('_') && !name.includes(' ');
        }
      }
    ];

    // Run each rule
    for (const rule of rules) {
      if (rule.check(flow)) {
        results.push({
          rule: rule.name,
          description: rule.description,
          severity: rule.severity,
          details: `Flow: ${flow.name}`
        });
      }
    }

    return results;
  }

  displayResults(results) {
    const container = document.getElementById('results-container');
    const totalIssues = document.getElementById('total-issues');
    
    totalIssues.textContent = results.length;
    
    if (results.length === 0) {
      container.innerHTML = '<div class="no-results">No issues found! Your flow looks good.</div>';
      return;
    }

    const resultsHTML = results.map(result => `
      <div class="issue-item">
        <div class="issue-header">
          <div class="issue-title">${result.rule}</div>
          <div class="issue-severity ${result.severity}">${result.severity}</div>
        </div>
        <div class="issue-description">${result.description}</div>
        <div class="issue-details">${result.details}</div>
      </div>
    `).join('');

    container.innerHTML = resultsHTML;
  }

  updateExportButton() {
    const exportBtn = document.getElementById('export-button');
    exportBtn.disabled = this.scanResults.length === 0;
  }

  exportResults() {
    if (this.scanResults.length === 0) {
      return;
    }

    const exportData = {
      flow: this.currentFlow,
      scanResults: this.scanResults,
      scanDate: new Date().toISOString(),
      totalIssues: this.scanResults.length,
      scannerVersion: this.flowScannerCore ? 'Flow Scanner Core' : 'Basic Scanner'
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: 'application/json'
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `flow-scan-${this.currentFlow.name}-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  showLoading(show) {
    const overlay = document.getElementById('loading-overlay');
    overlay.style.display = show ? 'flex' : 'none';
  }

  showError(message) {
    const container = document.getElementById('results-container');
    container.innerHTML = `<div class="no-results" style="color: #c62828;">Error: ${message}</div>`;
  }
}

// Initialize the flow scanner when the page loads
document.addEventListener('DOMContentLoaded', async () => {
  const args = new URLSearchParams(window.location.search);
  const sfHost = args.get('host');
  const flowDefId = args.get('flowDefId');
  const flowId = args.get('flowId');
  initButton(sfHost, true);
  await sfConn.getSession(sfHost);
  new FlowScanner(sfHost, flowDefId, flowId);
});

// Listen for messages from the parent window
window.addEventListener('message', (event) => {
  if (event.data.type === 'flow-scanner-init') {
    // Handle initialization from parent window
    console.log('Flow Scanner initialized from parent window');
  }
}); 