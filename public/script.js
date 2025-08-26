class ChatInterface {
    constructor() {
        this.conversationId = this.generateId();
        this.messageInput = document.getElementById('message-input');
        this.sendButton = document.getElementById('send-button');
        this.messagesContainer = document.getElementById('chat-messages');
        this.currentState = null;
        
        // Background element
        this.backgroundContainer = document.getElementById('background-container');
        this.socialProofContainer = document.getElementById('social-proof');
        this.lovedByContainer = document.getElementById('loved-by');
        this.hasStartedChat = false;
        
        // Itinerary elements
        this.itinerarySidebar = document.getElementById('itinerary-sidebar');
        this.itineraryContent = document.getElementById('itinerary-content');
        this.toggleButton = document.getElementById('toggle-sidebar');
        this.inputContainer = document.getElementById('chat-input-container');
        this.hasAnimatedInputToBottom = false;
        
        // Current itinerary data
        this.currentItinerary = null;
        this.tripFacts = null;
        this.hasShownSidebar = false;
        
        // Animation state flags for itinerary
        this.hasShownTripSummaryOnce = false;
        this.hasShownItineraryOnce = false;
        
        this.init();
    }

    // Add the same date handling method from the backend
    toLocalDate(input) {
        if (!input) return null;
        
        // If it's already a Date object, return it
        if (input instanceof Date) return input;
        
        // If it's YYYY-MM-DD format, parse it as local midnight
        if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
            const [y, m, d] = input.split('-').map(Number);
            // Create date at noon to avoid DST issues
            return new Date(y, m - 1, d, 12, 0, 0);
        }
        
        // For other formats, parse at noon to avoid timezone issues
        const date = new Date(input + ' 12:00:00');
        if (isNaN(date.getTime())) {
            // If that fails, try without the time
            return new Date(input);
        }
        return date;
    }

    // Helper to format dates and include year only if the date is in a future year
    formatDateWithConditionalYear(dateInput, localeOptions = { weekday: 'short', month: 'short', day: 'numeric' }) {
        if (!dateInput) return '';
        const date = this.toLocalDate(dateInput);
        const currentYear = new Date().getFullYear();
        const includeYear = date.getFullYear() > currentYear;
        const options = includeYear ? { ...localeOptions, year: 'numeric' } : localeOptions;
        return date.toLocaleDateString('en-US', options);
    }

    // Helper method to format budget with dollar sign
    formatBudget(budget) {
        if (!budget || budget === 'Not specified') {
            return 'Not specified';
        }
        
        // If it's already a string that starts with $, return as is
        if (typeof budget === 'string' && budget.startsWith('$')) {
            return budget;
        }
        
        // If it's a number or a string that can be parsed as a number
        const numericBudget = parseFloat(budget);
        if (!isNaN(numericBudget)) {
            return `$${numericBudget.toLocaleString()}`;
        }
        
        // For non-numeric strings (like "flexible", "to be determined"), 
        // capitalize first letter and return without dollar sign
        if (typeof budget === 'string') {
            return budget.charAt(0).toUpperCase() + budget.slice(1);
        }
        
        return 'Not specified';
    }

    formatBudgetWithScope(value, scope) {
        const base = this.formatBudget(value);
        if (base === 'Not specified') return base;
        if (scope === 'per_person') return `${base} per person`;
        if (scope === 'total') return `${base} total`;
        return base; // unknown scope
        }

    init() {
        this.setupEventListeners();
        if (this.toggleButton && this.itinerarySidebar) {
            this.toggleButton.textContent = this.itinerarySidebar.classList.contains('collapsed') ? '☰' : '×';
        }
        // Auto-focus the message input when page loads
        this.messageInput.focus();
        // Don't show welcome message initially - will show after first user message
    }

    setupEventListeners() {
        this.sendButton.addEventListener('click', () => this.sendMessage());
        this.messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });
        // Auto-resize textarea
        const autoResize = () => {
            this.messageInput.style.height = 'auto';
            const newHeight = Math.min(this.messageInput.scrollHeight, 240);
            this.messageInput.style.height = newHeight + 'px';
            this.messageInput.style.overflowY = this.messageInput.scrollHeight > 240 ? 'auto' : 'hidden';
        };
        ['input', 'change'].forEach(evt => {
            this.messageInput.addEventListener(evt, autoResize);
        });
        // Initialize size
        requestAnimationFrame(autoResize);
        
        // Sidebar toggle
        if (this.toggleButton) {
            this.toggleButton.addEventListener('click', () => this.toggleSidebar());
        }
    }

    toggleSidebar() {
        if (!this.itinerarySidebar || !this.toggleButton) return;
        this.itinerarySidebar.classList.toggle('collapsed');
        this.toggleButton.textContent = this.itinerarySidebar.classList.contains('collapsed') ? '☰' : '×';
    }

    ensureSidebarVisible() {
        if (!this.itinerarySidebar || !this.toggleButton) return;
        if (this.itinerarySidebar.classList.contains('collapsed')) {
            this.itinerarySidebar.classList.remove('collapsed');
        }
        this.toggleButton.textContent = '×';
    }

    fadeOutBackground() {
        if (this.backgroundContainer && !this.hasStartedChat) {
            this.backgroundContainer.classList.add('fade-out');
            this.hasStartedChat = true;
            
            // Remove the background element after fade completes to free up resources
            setTimeout(() => {
                if (this.backgroundContainer && this.backgroundContainer.parentNode) {
                    this.backgroundContainer.remove();
                    this.backgroundContainer = null;
                }
            }, 800); // Match the CSS transition duration
        }
    }

    fadeOutLandingElements() {
        if (this.hasStartedChat) return;
        this.hasStartedChat = true;
        if (this.backgroundContainer) {
            this.backgroundContainer.classList.add('fade-out');
        }
        if (this.socialProofContainer) {
            this.socialProofContainer.classList.add('fade-out');
        }
        const loved = this.lovedByContainer;
        if (loved) {
            loved.classList.add('fade-out');
        }
        setTimeout(() => {
            if (this.backgroundContainer && this.backgroundContainer.parentNode) {
                this.backgroundContainer.remove();
                this.backgroundContainer = null;
            }
            if (this.socialProofContainer && this.socialProofContainer.parentNode) {
                this.socialProofContainer.remove();
                this.socialProofContainer = null;
            }
            if (this.lovedByContainer && this.lovedByContainer.parentNode) {
                this.lovedByContainer.remove();
                this.lovedByContainer = null;
            }
        }, 800);
    }

    async sendMessage() {
        const message = this.messageInput.value.trim();
        if (!message) return;

        // Check if this is the first message before setting hasStartedChat
        const isFirstMessage = !this.hasStartedChat;

        // Fade out background on first message
        this.fadeOutLandingElements();

        // Show welcome message if this is the first user message
        if (isFirstMessage) {
            this.addMessage("On a scale from 1 - 10, how insane do you want your bachelor party to be?", 'bot');
        }

        // Add user message to chat
        this.addMessage(message, 'user');
        
        // Change placeholder text after first message
        if (isFirstMessage) {
            this.messageInput.placeholder = "Tell me about your bachelor party...";
            
            // Hide the prompt text after first message
            const promptText = document.querySelector('.input-prompt-text');
            if (promptText) {
                promptText.classList.add('hidden');
                // Remove element after animation completes
                setTimeout(() => {
                    if (promptText && promptText.parentNode) {
                        promptText.remove();
                    }
                }, 300); // Match the CSS transition duration
            }
        }
        
        // On first user message, animate input from center to bottom
        if (!this.hasAnimatedInputToBottom && this.inputContainer) {
            this.hasAnimatedInputToBottom = true;
            // Add slide-down state to trigger transition
            this.inputContainer.classList.add('slide-down');
            // Ensure messages are not hidden behind the fixed input
            if (this.messagesContainer) {
                this.messagesContainer.style.paddingBottom = '200px';
            }
            // Remove centered state after transition completes
            const onTransitionEnd = (e) => {
                if (e.propertyName === 'top' || e.propertyName === 'transform') {
                    this.inputContainer.classList.remove('centered');
                    this.inputContainer.removeEventListener('transitionend', onTransitionEnd);
                }
            };
            this.inputContainer.addEventListener('transitionend', onTransitionEnd);
        }
        if (!this.hasShownSidebar && this.itinerarySidebar) {
            this.ensureSidebarVisible();
            this.hasShownSidebar = true;
        }
        this.messageInput.value = '';
        this.sendButton.disabled = true;
        // Reset input height after sending
        this.messageInput.style.height = 'auto';
        this.messageInput.style.overflowY = 'hidden';

        try {
            // Show loading indicator
            this.showLoadingIndicator();
            
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    conversationId: this.conversationId,
                    message: message,
                    snapshot: this.currentState
                })
            });

            const result = await response.json();
            this.currentState = result.snapshot || this.currentState;
            
            // Hide loading indicator before showing response
            this.hideLoadingIndicator();
            
            // Add bot response to chat
            this.addMessage(result.response, 'bot');
            
            // Update itinerary if we have facts and are in planning phase
            if (result.facts) {
                this.tripFacts = result.facts;
                this.updateTripSummary();
            }
            
            // Update itinerary if we received itinerary data
            if (result.itinerary) {
                this.currentItinerary = result.itinerary;
                this.updateItinerary();
            }
            
            console.log('Conversation data:', result);
        } catch (error) {
            console.error('Error:', error);
            // Hide loading indicator on error
            this.hideLoadingIndicator();
            this.addMessage('Sorry, something went wrong. Please try again.', 'bot');
        } finally {
            this.sendButton.disabled = false;
            this.messageInput.focus();
        }
    }

    addMessage(content, sender) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${sender}-message`;
        messageDiv.textContent = content;
        this.messagesContainer.appendChild(messageDiv);
        
        // Scroll to bottom with a small delay to ensure the message is rendered
        setTimeout(() => {
            this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
        }, 50);
    }

    showLoadingIndicator() {
        // Remove any existing loading indicator first
        this.hideLoadingIndicator();
        
        const loadingDiv = document.createElement('div');
        loadingDiv.className = 'loading-indicator';
        loadingDiv.id = 'loading-indicator';
        loadingDiv.innerHTML = `
            <span class="loading-text">AI is typing</span>
            <div class="typing-dots">
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
            </div>
        `;
        
        this.messagesContainer.appendChild(loadingDiv);
        
        // Scroll to bottom with a small delay to ensure the loading indicator is rendered
        setTimeout(() => {
            this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
        }, 50);
    }

    hideLoadingIndicator() {
        const loadingIndicator = document.getElementById('loading-indicator');
        if (loadingIndicator) {
            loadingIndicator.remove();
        }
    }

    updateTripSummary() {
        if (!this.tripFacts || !this.itineraryContent) return;
        
        // Extract facts for display
        const destination = this.tripFacts.destination?.value || 'Not specified';
        const groupSize = this.tripFacts.groupSize?.value || 'Not specified';
        const startDate = this.tripFacts.startDate?.value || null;
        const endDate = this.tripFacts.endDate?.value || null;
        const budget = this.formatBudgetWithScope(
            this.tripFacts.budget?.value,
            this.tripFacts.budgetType?.value
            );        
        // Format dates using proper local date parsing
        let dateRange = 'Dates not set';
        if (startDate && endDate) {
            const start = this.formatDateWithConditionalYear(startDate);
            const end = this.formatDateWithConditionalYear(endDate);
            
            // Check if start and end dates are the same (single day event)
            if (startDate === endDate) {
                dateRange = start;
            } else {
                dateRange = `${start} - ${end}`;
            }
        } else if (startDate && !endDate) {
            // Only start date provided
            const start = this.formatDateWithConditionalYear(startDate);
            dateRange = `${start} (duration TBD)`;
        } else if (!startDate && endDate) {
            // Only end date provided (shouldn't happen, but handle it)
            const end = this.formatDateWithConditionalYear(endDate);
            dateRange = `Ends ${end}`;
        }
        
        const summaryHtml = `
            <div class="trip-summary ${this.hasShownTripSummaryOnce ? 'no-animate' : ''}">
                <h3>Your Trip to ${destination}</h3>
                <div class="trip-details">
                    <p><strong>📅 Dates:</strong> ${dateRange}</p>
                    <p><strong>👥 Group Size:</strong> ${groupSize} people</p>
                    <p><strong>💰 Budget:</strong> ${budget}</p>
                </div>
            </div>
        `;
        
        // Update the content
        this.itineraryContent.innerHTML = summaryHtml;
        this.hasShownTripSummaryOnce = true;
    }

    updateItinerary() {
        if (!this.itineraryContent || !this.currentItinerary || !Array.isArray(this.currentItinerary)) return;
        
        let itineraryHtml = '';
        
        // Add trip summary if we have facts
        if (this.tripFacts) {
            const destination = this.tripFacts.destination?.value || 'Your Destination';
            const groupSize = this.tripFacts.groupSize?.value || 'N/A';
            const startDate = this.tripFacts.startDate?.value || null;
            const endDate = this.tripFacts.endDate?.value || null;
            const budget = this.formatBudgetWithScope(
                this.tripFacts.budget?.value,
                this.tripFacts.budgetType?.value
                );                
            let dateRange = 'Dates not set';
            if (startDate && endDate) {
                const start = this.formatDateWithConditionalYear(startDate);
                const end = this.formatDateWithConditionalYear(endDate);
                
                // Check if start and end dates are the same (single day event)
                if (startDate === endDate) {
                    dateRange = start;
                } else {
                    dateRange = `${start} - ${end}`;
                }
            } else if (startDate && !endDate) {
                // Only start date provided
                const start = this.formatDateWithConditionalYear(startDate);
                dateRange = `${start} (duration TBD)`;
            }
            
            itineraryHtml += `
                <div class="trip-summary ${this.hasShownItineraryOnce ? 'no-animate' : ''}">
                    <h3>Your Trip to ${destination}</h3>
                    <div class="trip-details">
                        <p><strong>📅 Dates:</strong> ${dateRange}</p>
                        <p><strong>👥 Group Size:</strong> ${groupSize} people</p>
                        <p><strong>💰 Budget:</strong> ${budget}</p>
                    </div>
                </div>
            `;
        }
        
        // Add itinerary days
        this.currentItinerary.forEach((day, index) => {
            const dayDate = this.calculateDayDate(index);
            const services = this.dedupeServices(day.selectedServices || []);
            const bookingCount = services.length;
            const bookingText = bookingCount === 0 ? 'No bookings' : 
                               bookingCount === 1 ? '1 booking' : `${bookingCount} bookings`;
            
            itineraryHtml += `
                <div class="day-section ${this.hasShownItineraryOnce ? 'no-animate' : ''}">
                    <div class="day-header">
                        <div class="day-indicator"></div>
                        <div class="day-title">${dayDate}</div>
                        <div class="day-count">${bookingText}</div>
                    </div>
                    <div class="day-content">
            `;
            
            if (services.length > 0) {
                itineraryHtml += '<div class="day-services">';
                
                services.forEach(service => {
                    const timeSlot = this.formatTimeSlot(service.timeSlot);
                    const serviceName = this.truncateText(service.serviceName, 40);
                    const serviceDescription = this.truncateText(service.reason || 'Great experience for your group', 100);
                    
                    const isPending = this.isServicePending(service);
                    const statusClass = isPending ? 'pending' : 'confirmed';
                    const statusBadge = isPending ? '<span class="service-badge"></span>' : '';
                    
                    const groupSize = this.tripFacts?.groupSize?.value || 4;
                    const hasCad = typeof service.price_cad === 'number' && !isNaN(service.price_cad);
                    const hasUsd = typeof service.price_usd === 'number' && !isNaN(service.price_usd);
                    const price = hasCad ? service.price_cad : (hasUsd ? service.price_usd : this.generateMockPrice(service.serviceName));
                    const currency = hasCad ? 'CAD' : (hasUsd ? 'USD' : 'USD');
                    const totalPrice = price * groupSize;
                    
                    itineraryHtml += `
                      <div class="service-card ${statusClass} ${this.hasShownItineraryOnce ? 'no-animate' : ''}" data-service-id="${service.serviceId || ''}" data-pending="${isPending}">
                        <div class="service-card-content">
                          <div class="service-header">
                            <div class="service-time">${timeSlot || ''}</div>
                            ${statusBadge}
                            <div class="service-actions">
                              <button class="service-action-btn" title="Edit service">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                  <path d="m18.5 2.5 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                                </svg>
                              </button>
                              <button class="service-action-btn" title="Remove service">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                  <path d="M3 6h18"/>
                                  <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
                                  <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                                </svg>
                              </button>
                            </div>
                          </div>
                    
                          <div class="service-main">
                            <div class="service-image" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);"></div>
                            <div class="service-title">${serviceName}</div>
                          </div>
                    
                          <div class="service-description">${serviceDescription}</div>
                    
                          <div class="service-pricing">
                            <span class="service-price-per-person">$${price}/${currency} per person</span>
                            <span class="service-price-separator">|</span>
                            <span>$${Number(totalPrice || 0).toLocaleString()}</span>
                          </div>
                        </div>
                      </div>
                    `;
                });
                
                itineraryHtml += '</div>';
            } else {
                itineraryHtml += `
                    <div class="no-events">
                        <svg class="no-events-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="10"/>
                            <path d="M4.93 4.93 19.07 19.07"/>
                        </svg>
                        <span class="no-events-text">No experiences booked for this day</span>
                    </div>
                `;
            }
            
            itineraryHtml += `
                    </div>
                </div>
            `;
        });
        
        this.itineraryContent.innerHTML = itineraryHtml;
        // After first full itinerary render, disable further animations
        this.hasShownItineraryOnce = true;
        if (this.tripFacts) {
            this.hasShownTripSummaryOnce = true;
        }
    }

    calculateDayDate(dayIndex) {
        if (!this.tripFacts?.startDate?.value) {
            return `Day ${dayIndex + 1}`;
        }
        
        // Use proper local date parsing
        const startDate = this.toLocalDate(this.tripFacts.startDate.value);
        const dayDate = new Date(startDate);
        dayDate.setDate(startDate.getDate() + dayIndex);
        
        return dayDate.toLocaleDateString('en-US', { 
            weekday: 'long', 
            month: 'long', 
            day: 'numeric' 
        });
    }

    formatTimeSlot(timeSlot) {
        const timeMap = {
            'morning': 'Morning',
            'afternoon': 'Afternoon', 
            'evening': 'Evening',
            'night': 'Night',
            'late_night': 'Late Night'
        };
        return timeMap[timeSlot] || timeSlot || 'Morning';
    }

    truncateText(text, length) {
        if (!text) return '';
        if (text.length <= length) return text;
        return text.substring(0, length - 3) + '...';
    }

    getServiceKey(service) {
        // Prefer a stable unique id; fallback to name + timeSlot combo
        const idPart = service.serviceId && String(service.serviceId).trim();
        const namePart = (service.serviceName || '').trim();
        const timePart = (service.timeSlot || '').trim();
        return idPart || `${namePart}||${timePart}`;
    }

    isServicePending(service) {
        return service?.pending === true || service?.confirmed === false;
    }

    dedupeServices(services) {
        if (!Array.isArray(services)) return [];
        const keyToService = new Map();
        for (const service of services) {
            const key = this.getServiceKey(service);
            const existing = keyToService.get(key);
            if (!existing) {
                keyToService.set(key, service);
                continue;
            }
            const existingPending = this.isServicePending(existing);
            const currentPending = this.isServicePending(service);
            // Prefer confirmed over pending
            if (existingPending && !currentPending) {
                keyToService.set(key, service);
            } else if (!existingPending && currentPending) {
                // keep existing confirmed, ignore new pending
            } else {
                // If both are same status, keep the latest to reflect newest data
                keyToService.set(key, service);
            }
        }
        return Array.from(keyToService.values());
    }

    generateMockPrice(serviceName) {
        // Generate realistic pricing based on service type
        const name = serviceName.toLowerCase();
        if (name.includes('restaurant') || name.includes('dinner') || name.includes('lunch')) {
            return Math.floor(Math.random() * 100) + 50; // $50-150
        }
        if (name.includes('bar') || name.includes('club') || name.includes('drinks')) {
            return Math.floor(Math.random() * 80) + 30; // $30-110
        }
        if (name.includes('activity') || name.includes('adventure') || name.includes('experience')) {
            return Math.floor(Math.random() * 200) + 100; // $100-300
        }
        if (name.includes('hotel') || name.includes('accommodation')) {
            return Math.floor(Math.random() * 300) + 200; // $200-500
        }
        return Math.floor(Math.random() * 150) + 75; // Default $75-225
    }

    generateId() {
        return Math.random().toString(36).substring(2) + Date.now().toString(36);
    }
}

// Initialize the chat interface
document.addEventListener('DOMContentLoaded', () => {
    new ChatInterface();
});

document.addEventListener('keydown', (e) => {
    // Ctrl+9 seeds a 7-person Austin weekend instantly
    if (e.ctrlKey && e.key === '9') {
      this.messageInput.value = '/seed {"destination":"Austin","groupSize":7,"start":"2025-09-05","end":"2025-09-07","wild":5,"budget":"flexible"}';
      this.sendMessage();
    }
  });