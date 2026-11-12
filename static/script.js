(() => {
    // DOM Elements
    const nameInputWrapper = document.getElementById('nameInputWrapper');
    const nameInput = document.getElementById('nameInput');
    const inputHint = document.getElementById('inputHint');
    const formFeedback = document.getElementById('formFeedback');

    const myBookingBanner = document.getElementById('myBookingBanner');
    const mySlotBadge = document.getElementById('mySlotBadge');
    const myNameDisplay = document.getElementById('myNameDisplay');
    const cancelBookingBtn = document.getElementById('cancelBookingBtn');
    const btnCancelText = cancelBookingBtn ? cancelBookingBtn.querySelector('.btn-cancel-text') : null;
    const btnCancelSpinner = cancelBookingBtn ? cancelBookingBtn.querySelector('.btn-spinner') : null;

    const slotsGrid = document.getElementById('slotsGrid');
    const slotsCountBadge = document.getElementById('slotsCountBadge');

    const namesList = document.getElementById('namesList');
    const emptyState = document.getElementById('emptyState');
    const namesCountBadge = document.getElementById('namesCountBadge');

    const nextCleanupText = document.getElementById('nextCleanupText');
    const serverTimeText = document.getElementById('serverTimeText');
    const statusText = document.getElementById('statusText');

    const TOTAL_SLOTS = 15;
    let lastDataFingerprint = '';
    let isSubmitting = false;
    let isCancelling = false;
    let userBooking = null; // null or { id, slot, name, created_at }
    let slotsData = {};     // slotNumber (1..15) -> { id, slot, name, created_at, is_mine }

    const RU_MONTHS = [
        'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
        'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'
    ];

    // Helper: Escape HTML to avoid XSS
    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // Helper: Device ID management
    function getCookie(name) {
        const matches = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([\.$?*|{}\(\)\[\]\\\/\+^])/g, '\\$1') + '=([^;]*)'));
        return matches ? decodeURIComponent(matches[1]) : undefined;
    }

    function setCookie(name, value, days = 365) {
        const date = new Date();
        date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
        document.cookie = `${name}=${encodeURIComponent(value)}; expires=${date.toUTCString()}; path=/; SameSite=Lax`;
    }

    function initDeviceId() {
        let deviceId = '';
        try {
            deviceId = localStorage.getItem('autoq_device_id') || '';
        } catch (e) {
            console.warn('localStorage unavailable:', e);
        }

        if (!deviceId) {
            deviceId = getCookie('autoq_device_id') || '';
        }

        if (!deviceId) {
            if (typeof crypto !== 'undefined' && crypto.randomUUID) {
                deviceId = crypto.randomUUID();
            } else {
                deviceId = 'dev_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 12);
            }
        }

        // Store back in both places
        try {
            localStorage.setItem('autoq_device_id', deviceId);
        } catch (e) {}
        setCookie('autoq_device_id', deviceId);

        return deviceId;
    }

    const deviceId = initDeviceId();

    // Restore saved name
    try {
        const savedName = localStorage.getItem('autoq_user_name');
        if (savedName && !nameInput.value) {
            nameInput.value = savedName;
        }
    } catch (e) {}

    // Format date and time for entry display
    function formatEntryDateTime(createdAt) {
        if (!createdAt || typeof createdAt !== 'string') {
            return { date: '', time: '', full: '' };
        }

        const trimmed = createdAt.trim();
        const spaceIdx = trimmed.indexOf(' ');
        if (spaceIdx !== -1) {
            const datePart = trimmed.slice(0, spaceIdx);
            const timePart = trimmed.slice(spaceIdx + 1);
            const dateSubParts = datePart.split('.');
            if (dateSubParts.length === 3) {
                const day = parseInt(dateSubParts[0], 10);
                const monthIdx = parseInt(dateSubParts[1], 10) - 1;
                if (!isNaN(day) && monthIdx >= 0 && monthIdx < 12) {
                    return {
                        date: `${day} ${RU_MONTHS[monthIdx]}`,
                        time: timePart,
                        full: trimmed
                    };
                }
            }
        }

        const parsedDate = new Date(trimmed);
        if (!isNaN(parsedDate.getTime())) {
            const day = parsedDate.getDate();
            const monthIdx = parsedDate.getMonth();
            const hh = String(parsedDate.getHours()).padStart(2, '0');
            const mm = String(parsedDate.getMinutes()).padStart(2, '0');
            const ss = String(parsedDate.getSeconds()).padStart(2, '0');
            return {
                date: `${day} ${RU_MONTHS[monthIdx]}`,
                time: `${hh}:${mm}:${ss}`,
                full: trimmed
            };
        }

        return {
            date: '',
            time: trimmed,
            full: trimmed
        };
    }

    // Feedback notification
    let feedbackTimeout = null;
    function showFeedback(message, type = 'error', autoHideSeconds = 4) {
        if (feedbackTimeout) {
            clearTimeout(feedbackTimeout);
            feedbackTimeout = null;
        }

        formFeedback.textContent = message;
        formFeedback.className = `feedback ${type}`;
        formFeedback.classList.remove('hidden');

        if (autoHideSeconds > 0) {
            feedbackTimeout = setTimeout(() => {
                formFeedback.classList.add('hidden');
                feedbackTimeout = null;
            }, autoHideSeconds * 1000);
        }
    }

    function hideFeedback() {
        if (feedbackTimeout) {
            clearTimeout(feedbackTimeout);
            feedbackTimeout = null;
        }
        formFeedback.classList.add('hidden');
        formFeedback.textContent = '';
    }

    // Shake input if user clicked a slot without entering name
    function shakeInput() {
        nameInputWrapper.classList.remove('input-shake');
        // Force reflow
        void nameInputWrapper.offsetWidth;
        nameInputWrapper.classList.add('input-shake');
        nameInput.focus();
        setTimeout(() => {
            nameInputWrapper.classList.remove('input-shake');
        }, 600);
    }

    // Update the "My Booking" UI banner
    function updateMyBookingUI() {
        if (userBooking) {
            myBookingBanner.classList.remove('hidden');
            mySlotBadge.textContent = `№ ${userBooking.slot}`;
            myNameDisplay.textContent = userBooking.name;
            nameInput.value = userBooking.name;
            nameInput.disabled = true;
            inputHint.textContent = `У вас уже занято место №${userBooking.slot}. Одно устройство может занять только одно место.`;
        } else {
            myBookingBanner.classList.add('hidden');
            nameInput.disabled = false;
            inputHint.textContent = 'Введите имя, затем нажмите на свободный номер места ниже';
        }
    }

    // Render the 15 slot buttons
    function renderSlotsGrid() {
        slotsGrid.innerHTML = '';

        for (let i = 1; i <= TOTAL_SLOTS; i++) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'slot-btn';
            btn.dataset.slot = i;

            const numSpan = document.createElement('span');
            numSpan.className = 'slot-num';
            numSpan.textContent = i;

            const labelSpan = document.createElement('span');
            labelSpan.className = 'slot-label';

            const item = slotsData[i];

            if (!item) {
                // Available slot
                btn.classList.add('slot-free');
                labelSpan.textContent = 'Свободно';
                btn.title = `Нажмите, чтобы занять место №${i}`;
            } else if (item.is_mine) {
                // Current user's slot
                btn.classList.add('slot-mine');
                labelSpan.textContent = 'Ваше';
                btn.title = `Ваше место №${i} (${item.name})`;
            } else {
                // Occupied by someone else
                btn.classList.add('slot-taken');
                labelSpan.textContent = item.name;
                labelSpan.title = item.name;
                btn.title = `Место №${i} занято: ${item.name}`;
            }

            btn.appendChild(numSpan);
            btn.appendChild(labelSpan);

            btn.addEventListener('click', () => handleSlotClick(i));
            slotsGrid.appendChild(btn);
        }
    }

    // Handle slot button click
    async function handleSlotClick(slotNumber) {
        if (isSubmitting || isCancelling) return;

        const currentSlot = slotsData[slotNumber];

        // Case 1: Slot is occupied by the current user
        if (currentSlot && currentSlot.is_mine) {
            showFeedback(`Это ваше забронированное место №${slotNumber}. Если хотите выбрать другое, нажмите кнопку «Освободить» выше.`, 'info');
            return;
        }

        // Case 2: User already has another booking from this device
        if (userBooking) {
            showFeedback(`С вашего устройства уже занято место №${userBooking.slot} (${userBooking.name}). Чтобы сменить место, сначала освободите текущее.`, 'error');
            return;
        }

        // Case 3: Slot is occupied by another person
        if (currentSlot && !currentSlot.is_mine) {
            showFeedback(`Место №${slotNumber} уже занято (${currentSlot.name}). Пожалуйста, выберите другое свободное место.`, 'error');
            return;
        }

        // Case 4: Free slot - check name
        const name = nameInput.value.trim();
        if (!name) {
            showFeedback('Сначала введите ваше имя в поле выше!', 'error');
            shakeInput();
            return;
        }

        if (name.length < 2) {
            showFeedback('Имя должно содержать минимум 2 символа!', 'error');
            shakeInput();
            return;
        }

        if (name.length > 100) {
            showFeedback('Имя слишком длинное (максимум 100 символов)', 'error');
            shakeInput();
            return;
        }

        // Save name for convenience
        try {
            localStorage.setItem('autoq_user_name', name);
        } catch (e) {}

        // Proceed to book
        isSubmitting = true;
        const clickedBtn = slotsGrid.querySelector(`button[data-slot="${slotNumber}"]`);
        if (clickedBtn) {
            clickedBtn.classList.add('slot-loading');
        }

        hideFeedback();

        try {
            const response = await fetch('/api/names', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Device-Id': deviceId
                },
                body: JSON.stringify({
                    name: name,
                    slot: slotNumber,
                    deviceId: deviceId
                })
            });

            const result = await response.json();

            if (!response.ok || !result.success) {
                throw new Error(result.error || 'Не удалось занять выбранное место');
            }

            showFeedback(`🎉 Вы успешно заняли место №${slotNumber}!`, 'success');
            await fetchNames();
        } catch (err) {
            showFeedback(err.message || 'Ошибка при отправке запроса', 'error');
            await fetchNames();
        } finally {
            isSubmitting = false;
            if (clickedBtn) {
                clickedBtn.classList.remove('slot-loading');
            }
        }
    }

    // Cancel own booking
    if (cancelBookingBtn) {
        cancelBookingBtn.addEventListener('click', async () => {
            if (isCancelling || !userBooking) return;

            const confirmed = window.confirm(`Освободить ваше место №${userBooking.slot}? После этого любой сможет его занять.`);
            if (!confirmed) return;

            isCancelling = true;
            cancelBookingBtn.disabled = true;
            if (btnCancelText) btnCancelText.classList.add('hidden');
            if (btnCancelSpinner) btnCancelSpinner.classList.remove('hidden');

            try {
                const response = await fetch('/api/names/cancel', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Device-Id': deviceId
                    },
                    body: JSON.stringify({ deviceId: deviceId })
                });

                const result = await response.json();

                if (!response.ok || !result.success) {
                    throw new Error(result.error || 'Не удалось отменить запись');
                }

                showFeedback('Ваше место освобождено. Теперь вы можете выбрать новое место.', 'info');
                userBooking = null;
                updateMyBookingUI();
                await fetchNames();
            } catch (err) {
                showFeedback(err.message || 'Ошибка отмены брони', 'error');
            } finally {
                isCancelling = false;
                cancelBookingBtn.disabled = false;
                if (btnCancelText) btnCancelText.classList.remove('hidden');
                if (btnCancelSpinner) btnCancelSpinner.classList.add('hidden');
            }
        });
    }

    // Render ordered final list of participants
    function renderOrderedList(names) {
        const occupiedCount = names.length;
        slotsCountBadge.textContent = `Занято: ${occupiedCount} / ${TOTAL_SLOTS}`;
        namesCountBadge.textContent = `${occupiedCount} чел.`;

        if (occupiedCount === 0) {
            namesList.classList.add('hidden');
            namesList.innerHTML = '';
            emptyState.classList.remove('hidden');
            return;
        }

        emptyState.classList.add('hidden');
        namesList.classList.remove('hidden');
        namesList.innerHTML = '';

        names.forEach((item) => {
            const li = document.createElement('li');
            li.className = 'name-item' + (item.is_mine ? ' is-mine' : '');

            const leftDiv = document.createElement('div');
            leftDiv.className = 'name-left';

            const rankBadge = document.createElement('span');
            rankBadge.className = 'rank-badge';
            rankBadge.textContent = `№ ${item.slot}`;

            const nameDetails = document.createElement('div');
            nameDetails.className = 'name-details';

            const nameSpan = document.createElement('span');
            nameSpan.className = 'name-text';
            nameSpan.textContent = item.name;

            nameDetails.appendChild(nameSpan);

            if (item.is_mine) {
                const youBadge = document.createElement('span');
                youBadge.className = 'you-badge';
                youBadge.textContent = 'Вы';
                nameDetails.appendChild(youBadge);
            }

            leftDiv.appendChild(rankBadge);
            leftDiv.appendChild(nameDetails);

            const timeDiv = document.createElement('div');
            timeDiv.className = 'name-time';
            timeDiv.title = `Запись создана: ${item.created_at || ''}`;

            const dt = formatEntryDateTime(item.created_at);
            if (dt.date) {
                const dateSpan = document.createElement('span');
                dateSpan.className = 'time-date';
                dateSpan.textContent = dt.date;
                timeDiv.appendChild(dateSpan);
            }

            if (dt.time) {
                const clockSpan = document.createElement('span');
                clockSpan.className = 'time-clock';
                clockSpan.textContent = dt.time;
                timeDiv.appendChild(clockSpan);
            }

            li.appendChild(leftDiv);
            li.appendChild(timeDiv);

            namesList.appendChild(li);
        });
    }

    // Fetch names and status from API
    async function fetchNames() {
        try {
            const response = await fetch('/api/names', {
                headers: {
                    'X-Device-Id': deviceId
                }
            });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            const data = await response.json();
            if (!data.success) throw new Error(data.error || 'Ошибка загрузки данных');

            // Update schedule / server time info
            if (data.next_cleanup && data.next_cleanup.formatted) {
                nextCleanupText.textContent = data.next_cleanup.formatted;
            }
            if (data.server_time) {
                serverTimeText.textContent = `Сервер: ${data.server_time}`;
            }

            // Update user booking
            userBooking = data.user_booking || null;
            updateMyBookingUI();

            // Rebuild slots map
            const newSlotsData = {};
            (data.names || []).forEach(item => {
                newSlotsData[item.slot] = item;
            });
            slotsData = newSlotsData;

            // Check if state changed before full re-render
            const currentFingerprint = JSON.stringify({
                names: data.names,
                myBooking: userBooking
            });

            if (currentFingerprint !== lastDataFingerprint) {
                lastDataFingerprint = currentFingerprint;
                renderSlotsGrid();
                renderOrderedList(data.names || []);
            }

            statusText.textContent = 'Автообновление активно';
        } catch (err) {
            console.error('Fetch error:', err);
            statusText.textContent = 'Переподключение к серверу...';
        }
    }

    // Initial render of empty grid and initial fetch
    renderSlotsGrid();
    fetchNames();

    // Regular polling every 2.5 seconds
    setInterval(fetchNames, 2500);
})();
