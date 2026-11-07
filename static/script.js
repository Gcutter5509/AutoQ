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

            const timeSpan = document.createElement('span');
            timeSpan.className = 'name-time';
            // Extract time portion if created_at is in 'DD.MM.YYYY HH:MM:SS' format
            const timeParts = item.created_at ? item.created_at.split(' ') : [];
            timeSpan.textContent = timeParts.length > 1 ? timeParts[1] : item.created_at;
            timeSpan.title = item.created_at || '';

            li.appendChild(leftDiv);
            li.appendChild(timeSpan);

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
