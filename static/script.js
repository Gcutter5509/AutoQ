(() => {
    // DOM Elements
    const nameForm = document.getElementById('nameForm');
    const nameInput = document.getElementById('nameInput');
    const submitBtn = document.getElementById('submitBtn');
    const btnText = submitBtn.querySelector('.btn-text');
    const btnSpinner = submitBtn.querySelector('.btn-spinner');
    const formFeedback = document.getElementById('formFeedback');
    
    const namesList = document.getElementById('namesList');
    const emptyState = document.getElementById('emptyState');
    const namesCountBadge = document.getElementById('namesCountBadge');
    
    const nextCleanupText = document.getElementById('nextCleanupText');
    const serverTimeText = document.getElementById('serverTimeText');
    const statusText = document.getElementById('statusText');

    let lastDataFingerprint = '';
    let isSubmitting = false;

    const RU_MONTHS = [
        'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
        'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'
    ];

    // Format date and time for entry display (e.g. "9 ноября" and "19:23:20")
    function formatEntryDateTime(createdAt) {
        if (!createdAt || typeof createdAt !== 'string') {
            return { date: '', time: '', full: '' };
        }

        const trimmed = createdAt.trim();

        // Case 1: "DD.MM.YYYY HH:MM:SS" or "DD.MM.YYYY HH:MM"
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

        // Case 2: ISO string or Date-parseable string
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

        // Fallback: return as-is
        return {
            date: '',
            time: trimmed,
            full: trimmed
        };
    }

    // Show feedback message (error / success)
    function showFeedback(message, type = 'error') {
        formFeedback.textContent = message;
        formFeedback.className = `feedback ${type}`;
        formFeedback.classList.remove('hidden');

        if (type === 'success') {
            setTimeout(() => {
                formFeedback.classList.add('hidden');
            }, 3000);
        }
    }

    function hideFeedback() {
        formFeedback.classList.add('hidden');
        formFeedback.textContent = '';
    }

    // Set submit button loading state
    function setSubmitting(state) {
        isSubmitting = state;
        submitBtn.disabled = state;
        nameInput.disabled = state;
        if (state) {
            btnText.classList.add('hidden');
            btnSpinner.classList.remove('hidden');
        } else {
            btnText.classList.remove('hidden');
            btnSpinner.classList.add('hidden');
        }
    }

    // Render list of names
    function renderNames(names) {
        if (!names || names.length === 0) {
            namesList.classList.add('hidden');
            namesList.innerHTML = '';
            emptyState.classList.remove('hidden');
            namesCountBadge.textContent = '0';
            return;
        }

        emptyState.classList.add('hidden');
        namesList.classList.remove('hidden');
        namesCountBadge.textContent = names.length.toString();

        // Clear and rebuild list
        namesList.innerHTML = '';
        names.forEach((item, index) => {
            const li = document.createElement('li');
            li.className = 'name-item';

            const leftDiv = document.createElement('div');
            leftDiv.className = 'name-left';

            const rankBadge = document.createElement('span');
            rankBadge.className = 'rank-badge';
            rankBadge.textContent = `#${index + 1}`;

            const nameSpan = document.createElement('span');
            nameSpan.className = 'name-text';
            nameSpan.textContent = item.name; // safe from XSS

            leftDiv.appendChild(rankBadge);
            leftDiv.appendChild(nameSpan);

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
            const response = await fetch('/api/names');
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

            // Check if names changed before re-rendering
            const currentFingerprint = JSON.stringify(data.names);
            if (currentFingerprint !== lastDataFingerprint) {
                lastDataFingerprint = currentFingerprint;
                renderNames(data.names);
            }

            statusText.textContent = 'Автообновление активно';
        } catch (err) {
            console.error('Fetch error:', err);
            statusText.textContent = 'Переподключение к серверу...';
        }
    }

    // Handle form submit
    nameForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (isSubmitting) return;

        const name = nameInput.value.trim();
        if (!name) {
            showFeedback('Пожалуйста, введите ваше имя');
            nameInput.focus();
            return;
        }

        hideFeedback();
        setSubmitting(true);

        try {
            const response = await fetch('/api/names', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ name })
            });

            const result = await response.json();

            if (!response.ok || !result.success) {
                throw new Error(result.error || 'Не удалось сохранить имя');
            }

            // Successfully added
            nameInput.value = '';
            showFeedback(`Имя "${name}" успешно добавлено!`, 'success');
            await fetchNames();
        } catch (err) {
            showFeedback(err.message || 'Произошла ошибка при отправке');
        } finally {
            setSubmitting(false);
            nameInput.focus();
        }
    });

    // Initial load
    fetchNames();

    // Regular polling every 2.5 seconds
    setInterval(fetchNames, 2500);
})();
