/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { GoogleGenAI } from '@google/genai';
import { useEffect, useState, useRef } from 'react';
import ReactDOM from 'react-dom/client';

// --- TYPES ---
type MainView = 'summary' | 'entries' | 'assistant';

interface Budget {
  [category: string]: number;
}

interface Expense {
  category: string;
  amount: number;
  date: string;
}

interface ChatMessage {
  role: 'user' | 'model';
  text: string;
  images?: string[];
}

// --- HELPERS ---
const formatCurrency = (value: number, decimals = false) => {
  return value.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: decimals ? 2 : 0,
    maximumFractionDigits: decimals ? 2 : 0,
  });
};

const getMonthYear = (date = new Date()) => `${date.getFullYear()}-${date.getMonth() + 1}`;

const formatMonthYear = (monthKey: string, short = false) => {
    const [year, month] = monthKey.split('-');
    const date = new Date(parseInt(year), parseInt(month) - 1);
    const options: Intl.DateTimeFormatOptions = short
        ? { month: 'short', year: 'numeric' }
        : { month: 'long', year: 'numeric' };
    let formatted = date.toLocaleDateString('pt-BR', options);
    return formatted.charAt(0).toUpperCase() + formatted.slice(1);
};

// --- AI INSTANCE & SYSTEM INSTRUCTION ---
const SYSTEM_INSTRUCTION = `
Você é um assistente de finanças pessoais amigável, inteligente e proativo. Sua tarefa é ajudar o usuário a gerenciar orçamentos e despesas de forma conversacional.

O estado atual das finanças é fornecido em JSON, contendo os orçamentos ('budgets') e um resumo dos gastos por categoria ('expenseSummary').

Responda SEMPRE em formato JSON.

--- FLUXO DE CONVERSA ---

FLUXO 1: AÇÃO DIRETA (PARA SOLICITAÇÕES CLARAS)
Quando um pedido do usuário for claro e inequívoco (ex: adicionar um gasto a uma categoria existente), execute a ação diretamente.

1.  **Ações Finais:** 'SET_BUDGET', 'ADD_EXPENSE'
2.  **Payload:** Os dados para a ação.
3.  **Response:** Uma mensagem de confirmação amigável do que você fez.
    -   Usuário: "gastei 50 no mercado"
    -   Sua resposta JSON:
        {
          "action": "ADD_EXPENSE",
          "payload": [{ "category": "mercado", "amount": 50 }],
          "response": "Anotado! Gasto de R$ 50 na categoria 'mercado' registrado."
        }
    -   Usuário: "orçamento mercado 500"
    -   Sua resposta JSON:
        {
          "action": "SET_BUDGET",
          "payload": { "mercado": 500 },
          "response": "Pronto! Orçamento de R$ 500 para 'mercado' definido."
        }

--- 

FLUXO 2: CONFIRMAÇÃO (PARA SOLICITAÇÕES AMBÍGUAS OU IMPORTANTES)
Use este fluxo quando precisar de esclarecimentos ou para ações críticas como 'virar o mès'.

1. Ação inicial: 'CONFIRM_ACTION'
   -   **Payload:** 'actionToConfirm' (a ação final) e 'data'.
   -   **Response:** Uma pergunta clara ao usuário.
   -   **Exemplo (Adivinhação de Categoria):
     -   Usuário: "gastei 1101 no rancho" (e a categoria 'mercado' existe)
     -   Sua resposta JSON:
        {
          "action": "CONFIRM_ACTION",
          "payload": {
            "actionToConfirm": "ADD_EXPENSE",
            "data": [{ "category": "mercado", "amount": 1101 }]
          },
          "response": "Não encontrei a categoria 'rancho'. Você quis dizer 'mercado'? Posso registrar o gasto de R$ 1101 lá?"
        }
    -  **Exemplo (Virar o Mès):
      - Usuário: "vamos para o próximo mès"
      - Sua resposta JSON:
        {
          "action": "CONFIRM_ACTION",
          "payload": {
            "actionToConfirm": "NEXT_MONTH",
            "data": {}
          },
          "response": "Ok! Deseja arquivar este mès e começar um novo? Posso copiar seus orçamentos atuais para o próximo mès?"
        }

2. Resposta do usuário à confirmação:
   - Se o usuário confirmar ('sim', 'pode copiar'), responda com a ação final ('ADD_EXPENSE', 'NEXT_MONTH', etc.).
     - Usuário (respondendo ao pedido de virar o mès): "sim, copia os orçamentos"
     - Sua resposta JSON:
       {
         "action": "NEXT_MONTH",
         "payload": { "copyBudgets": true },
         "response": "Tudo certo! Iniciando o novo mès com seus orçamentos copiados."
       }
   - Se o usuário negar, responda com 'CANCEL_ACTION'.

--- 

FLUXO 3: VISUALIZAR OUTRO MÈS
Quando o usuário pedir para ver dados de um mès anterior.

1.  Ação: 'VIEW_PREVIOUS_MONTH'
2.  **Payload:** 'year' e 'month' (número do mès, 1-12).
3.  **Response:** Uma mensagem indicando que você está carregando os dados.
    -   Usuário: "me mostra os gastos de junho de 2024"
    -   Sua resposta JSON:
        {
          "action": "VIEW_PREVIOUS_MONTH",
          "payload": { "year": 2024, "month": 6 },
          "response": "Claro! Carregando os dados de Junho de 2024."
        }
---

FLUXO 4: SUGESTÃO DE ORÇAMENTO (SEJA PROATIVO!)
Quando o usuário pedir ajuda para criar um orçamento (ex: "sugira um orçamento pra mim", "me ajuda a pensar", "distribua os valores"), você DEVE ser proativo. NÃO peça mais informações. Crie e sugira um plano completo.

1.  **Ação:** Use 'CONFIRM_ACTION' para propor o orçamento.
2.  **Payload:** 'actionToConfirm' será 'SET_BUDGET', e 'data' será o objeto de orçamento completo que você criou.
3.  **Response:** Apresente a sugestão de forma clara e amigável, e pergunte se o usuário aprova.
    -   Usuário: "me ajuda a pensar num orçamento, ganho 11000"
    -   Sua resposta JSON:
        {
          "action": "CONFIRM_ACTION",
          "payload": {
            "actionToConfirm": "SET_BUDGET",
            "data": {
              "Hotéis 🏠": 3000,
              "Contas 💡": 500,
              "Mercado 🛒": 1500,
              "Transporte 🚗": 600,
              "Saúde 🏥": 400,
              "Lazer 🎉": 1000,
              "Cuidados Pessoais 💄": 500,
              "Investimentos 📈": 2500,
              "Emergências 🆘": 1000
            }
          },
          "response": "Com certeza! Com base no seu salário de R$ 11.000, preparei uma sugestão de orçamento detalhada para você, usando categorias específicas. Dè uma olhada:\n\n- **Hotéis 🏠:** R$ 3.000\n- **Contas 💡:** R$ 500\n- **Mercado 🛒:** R$ 1.500\n- **Transporte 🚗:** R$ 600\n- **Saúde 🏥:** R$ 400\n- **Lazer 🎉:** R$ 1.000\n- **Cuidados Pessoais 💄:** R$ 500\n- **Investimentos 📈:** R$ 2.500\n- **Emergências 🆘:** R$ 1.000\n\nO que você acha? Posso definir este como o seu orçamento para o mès?"
        }

--- 

FLUXO 5: PROCESSAMENTO DE IMAGEM (NOTA FISCAL)
Quando o usuário enviar uma imagem, extraia as informações e peça confirmação.

1.  **Análise da Imagem:** Extraia o valor total e sugira uma categoria provável (ex: 'Mercado', 'Restaurante', 'Transporte').
2.  **Ação de Confirmação:** Use 'CONFIRM_ACTION'.
    -   **Payload:** 'actionToConfirm' será 'ADD_EXPENSE', e 'data' conterá a categoria e o valor extraídos.
    -   **Response:** Apresente os dados extraídos e peça a confirmação do usuário.
    -   **Exemplo (Usuário envia foto de nota de supermercado):**
        -   Sua resposta JSON:
            {
              "action": "CONFIRM_ACTION",
              "payload": {
                "actionToConfirm": "ADD_EXPENSE",
                "data": [{ "category": "Mercado", "amount": 185.70 }]
              },
              "response": "Analisei a nota fiscal e encontrei um total de R$ 185,70. A categoria parece ser 'Mercado'. Está correto? Posso adicionar este gasto?"
            }
3.  **Resposta do Usuário:**
    -   Se o usuário confirmar, proceda com a ação 'ADD_EXPENSE'.
    -   Se o usuário corrigir ("não, foi farmácia"), atualize a categoria e adicione o gasto.
    -   Se o usuário negar, cancele com 'CANCEL_ACTION'.

---

FLUXO 6: EXCLUSÃO DE DADOS
Quando o usuário pedir para excluir dados, categorias ou limpar tudo, você deve confirmar a ação antes de executá-la.

1.  **Ação de Confirmação:** Use 'CONFIRM_ACTION' para pedir confirmação ao usuário.
2.  **Payload:** 'actionToConfirm' será uma das seguintes ações:
    - 'CLEAR_ALL_DATA': Para excluir todos os dados
    - 'DELETE_CATEGORY': Para excluir uma categoria específica
3.  **Response:** Pergunte ao usuário se ele tem certeza da ação.
    -   Exemplo (usuário pede para excluir tudo):
        {
          "action": "CONFIRM_ACTION",
          "payload": {
            "actionToConfirm": "CLEAR_ALL_DATA",
            "data": {}
          },
          "response": "Tem certeza que deseja excluir todos os dados? Esta ação não pode ser desfeita."
        }
    -   Exemplo (usuário pede para excluir categoria "mercado"):
        {
          "action": "CONFIRM_ACTION",
          "payload": {
            "actionToConfirm": "DELETE_CATEGORY",
            "data": { "category": "mercado" }
          },
          "response": "Tem certeza que deseja excluir a categoria 'mercado' e todos os seus dados? Esta ação não pode ser desfeita."
        }
4.  **Resposta do Usuário:**
    -   Se o usuário confirmar, responda com a ação final ('CLEAR_ALL_DATA' ou 'DELETE_CATEGORY').
    -   Se o usuário negar, responda com 'CANCEL_ACTION'.

--- REGRAS IMPORTANTES ---
- SEJA PROATIVO, NÃO PASSIVO: Se o usuário pedir uma sugestão, CRIE E APRESENTE UMA. Não devolva a pergunta.
- PRESERVE OS NOMES DAS CATEGORIAS: "jantar fora" deve ser "jantar fora" no JSON. NÃO use underscores.
- SIGA O FORMATO JSON: Sua resposta DEVE sempre ser um JSON válido.
`;
const ai = new GoogleGenAI({ apiKey: "AIzaSyBodxRZLyiZuSlCE4HBSv2QtmGQnk71Umc" });

// --- SVG ICONS ---
const PlusIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12h14"/>
        <path d="M12 5v14"/>
    </svg>
);

const CameraIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/>
        <circle cx="12" cy="13" r="3"/>
    </svg>
);

const SendIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 2 11 13"/>
        <path d="m22 2-7 20-4-9-9-4 20-7z"/>
    </svg>
);

// --- COMPONENTS ---

const AppHeader = ({ viewedMonth, onMonthChange, currentMonth }: {
  viewedMonth: string;
  onMonthChange: (direction: 'prev' | 'next') => void;
  currentMonth: string;
}) => {
  const isCurrentMonth = viewedMonth === currentMonth;
  return (
    <header className="app-header">
      <h1 className="app-title">Assistente Financeiro</h1>
      <div className="month-switcher">
        <button onClick={() => onMonthChange('prev')} aria-label="Mês anterior" className="month-switcher-button">‹</button>
        <span className="month-switcher-label">{formatMonthYear(viewedMonth, true)}</span>
        <button onClick={() => onMonthChange('next')} disabled={isCurrentMonth} aria-label="Próximo mês" className="month-switcher-button">›</button>
      </div>
    </header>
  );
};

const SegmentedControl = ({ selected, onSelect }: { selected: MainView, onSelect: (view: MainView) => void }) => {
  const views: MainView[] = ['summary', 'entries', 'assistant'];
  const labels: { [key in MainView]: string } = { summary: 'Resumo', entries: 'Lançamentos', assistant: 'Assistente' };
  return (
    <nav className="segmented-control">
      {views.map(view => (
        <button key={view} className={`segment-button ${selected === view ? 'active' : ''}`} onClick={() => onSelect(view)} aria-pressed={selected === view}>
          {labels[view]}
        </button>
      ))}
    </nav>
  );
};

const KpiCard = ({ title, value, highlight = false }: { title: string, value: string, highlight?: boolean }) => (
    <div className={`kpi-card ${highlight ? 'kpi-card-highlight' : ''}`}>
        <span className="kpi-title">{title}</span>
        <span className="kpi-value">{value}</span>
    </div>
);

const CategoryCard = ({ category, budget, spent }: { category: string, budget: number, spent: number }) => {
    if (budget === 0) {
        return (
            <div className="category-card empty p-4 shadow-sm">
                <span className="category-title">{category}</span>
                <button className="define-budget-cta">Definir orçamento</button>
            </div>
        )
    }
    const percentage = budget > 0 ? (spent / budget) * 100 : 0;
    const remaining = budget - spent;
    const isOverBudget = percentage > 100;
    let progressColor = 'var(--success-color)';
    if (isOverBudget) progressColor = 'var(--danger-color)';
    else if (percentage > 70) progressColor = 'var(--warning-color)';

    return (
        <div className="category-card p-4 shadow-sm">
            <div className="card-header">
                <span className="category-title">{category}</span>
            </div>
            <div className="progress-bar-container">
                <div className="progress-bar">
                    <div className="progress-bar-fill" style={{ width: `${Math.min(percentage, 100)}%`, backgroundColor: progressColor }}></div>
                </div>
                <span className="progress-percentage">{percentage.toFixed(0)}%</span>
            </div>
            <div className="card-footer">
                <span className="progress-label">{formatCurrency(spent)} de {formatCurrency(budget)}</span>
                {isOverBudget ? (
                    <span className="chip over-budget">Estourou +{formatCurrency(spent - budget)}</span>
                ) : (
                    <span className="chip remaining">Ainda tem {formatCurrency(remaining)}</span>
                )}
            </div>
        </div>
    );
};

const FloatingActionButton = ({ onClick }: { onClick: () => void }) => (
    <button className="fab" onClick={onClick} aria-label="Adicionar novo lançamento">
        <PlusIcon />
    </button>
);

const SummaryView = ({ budgets, expenses, viewedMonth }: { budgets: Budget, expenses: Expense[], viewedMonth: string }) => {
  const totalBudget = Object.values(budgets).reduce((sum, amount) => sum + amount, 0);
  const totalSpent = expenses.reduce((sum, expense) => sum + expense.amount, 0);
  const totalAvailable = totalBudget - totalSpent;
  const calculateSpentPerCategory = (category: string) => expenses.filter(e => e.category.toLowerCase() === category.toLowerCase()).reduce((sum, e) => sum + e.amount, 0);
  const budgetKeys = Object.keys(budgets);

  if (budgetKeys.length === 0) {
      return (
          <div className="view-container empty-state">
              <p>Nenhum orçamento definido para {formatMonthYear(viewedMonth)}.</p>
              <p>Use o assistente para criar um!</p>
          </div>
      )
  }

  return (
    <div className="view-container summary-view">
      <div className="kpi-container">
        <div className="kpi-row">
          <KpiCard title="Gasto no mês" value={formatCurrency(totalSpent)} />
          <KpiCard title="Orçado" value={formatCurrency(totalBudget)} />
        </div>
        <div className="kpi-row">
          <KpiCard title="Ainda tem" value={formatCurrency(totalAvailable)} highlight />
        </div>
      </div>
      <div className="category-cards-container gap-3">
        {budgetKeys.map(category => (
                <CategoryCard key={category} category={category} budget={budgets[category]} spent={calculateSpentPerCategory(category)} />
            ))}
        </div>
    </div>
  );
};

const AssistantView = ({ messages, onSendMessage, isLoading }: { messages: ChatMessage[], onSendMessage: (msg: string, images?: File[]) => void, isLoading: boolean }) => {
  const [input, setInput] = useState('');
  const handleSuggestionClick = (suggestion: string) => {
    setInput(suggestion);
  };

  return (
    <div className="view-container assistant-view">
        <div className="assistant-greeting"><p>Olá! Como posso ajudar hoje?</p></div>
        <div className="suggestion-chips">
            <button onClick={() => handleSuggestionClick('Definir orçamentos para o mês')}>Definir orçamentos</button>
            <button onClick={() => handleSuggestionClick('Adicionar gasto de R$50 em mercado')}>Adicionar gasto R$50</button>
            <button onClick={() => handleSuggestionClick('Quais categorias estão no vermelho?')}>Ver categorias no vermelho</button>
        </div>
        <ChatInterface messages={messages} onSendMessage={onSendMessage} isLoading={isLoading} input={input} setInput={setInput} />
    </div>
  );
};

const ExpenseList = ({ expenses }: { expenses: Expense[] }) => {
  if (expenses.length === 0) {
    return (
      <div className="view-container empty-state"><p className="empty-list-message">Nenhum lançamento neste mês.</p></div>
    );
  }
  return (
    <div className="view-container expense-list">
      <ul>
        {expenses.slice().reverse().map((expense, index) => (
          <li key={index}>
            <span className="expense-category">{expense.category}</span>
            <span className="expense-date">{new Date(expense.date).toLocaleDateString('pt-BR')}</span>
            <span className="expense-amount">- {formatCurrency(expense.amount)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

const ChatInterface = ({ messages, onSendMessage, isLoading, input, setInput }: { messages: ChatMessage[]; onSendMessage: (msg: string, images?: File[]) => void; isLoading: boolean; input: string; setInput: (value: string) => void; }) => {
  const chatHistoryRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedImages, setSelectedImages] = useState<File[]>([]);

  useEffect(() => { if (chatHistoryRef.current) { chatHistoryRef.current.scrollTop = chatHistoryRef.current.scrollHeight; } }, [messages, isLoading]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [input]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleImageSelection = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) {
      const files = Array.from(event.target.files);
      setSelectedImages(files);
      // Automatically send the message if there's no text input
      if (!input.trim()) {
        onSendMessage("", files);
        setInput('');
        setSelectedImages([]);
        if(fileInputRef.current) fileInputRef.current.value = '';
      }
    }
  };

  const handleSubmit = () => {
    if ((input.trim() || selectedImages.length > 0) && !isLoading) {
      onSendMessage(input.trim(), selectedImages);
      setInput('');
      setSelectedImages([]);
      if(fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="chat-container">
      <div className="chat-history" ref={chatHistoryRef}>
        {messages.map((msg, index) => (
          <div key={index} className={`message ${msg.role}`}>
            {msg.text.split('\n').map((line, i) => <p key={i}>{line}</p>)}
            {msg.images && (
              <div className="message-images">
                {msg.images.map((img, i) => <img key={i} src={img} alt="Uploaded content" />)}
              </div>
            )}
          </div>
        ))}
        {isLoading && <div className="message model thinking">...</div>}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); handleSubmit(); }} className="chat-form">
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleImageSelection}
          multiple
          accept="image/*"
          style={{ display: 'none' }}
          id="image-upload"
        />
        <button type="button" className="icon-button" onClick={() => fileInputRef.current?.click()} aria-label="Adicionar imagem">
          <CameraIcon />
        </button>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Digite seu comando..."
          aria-label="Chat input"
          disabled={isLoading}
          rows={1}
        />
        <button type="submit" className="icon-button" disabled={isLoading || (!input.trim() && selectedImages.length === 0)}>
          <SendIcon />
        </button>
      </form>
    </div>
  );
};

// --- MAIN APP COMPONENT ---

function App() {
  const [mainView, setMainView] = useState<MainView>('summary');
  const [currentMonth, setCurrentMonth] = useState(getMonthYear());
  const [viewedMonth, setViewedMonth] = useState(getMonthYear());
  const [budgets, setBudgets] = useState<Budget>({});
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([{ role: 'model', text: 'Olá! Sou seu assistente financeiro.' }]);
  const [isLoading, setIsLoading] = useState(false);
  const [pendingAction, setPendingAction] = useState<any | null>(null);

  useEffect(() => {
    const savedBudgets = localStorage.getItem(`budgets_${viewedMonth}`);
    const savedExpenses = localStorage.getItem(`expenses_${viewedMonth}`);
    setBudgets(savedBudgets ? JSON.parse(savedBudgets) : { "Moradia": 2000, "Alimentação": 1000, "Transporte": 500, "Lazer": 800 });
    setExpenses(savedExpenses ? JSON.parse(savedExpenses) : [{category: "Alimentação", amount: 350, date: new Date().toISOString()}, {category: "Lazer", amount: 600, date: new Date().toISOString()}]);
  }, [viewedMonth]);

  useEffect(() => { localStorage.setItem(`budgets_${viewedMonth}`, JSON.stringify(budgets)); }, [budgets, viewedMonth]);
  useEffect(() => { localStorage.setItem(`expenses_${viewedMonth}`, JSON.stringify(expenses)); }, [expenses, viewedMonth]);

  const handleMonthChange = (direction: 'prev' | 'next') => {
    const [year, month] = viewedMonth.split('-').map(Number);
    const newDate = new Date(year, month - (direction === 'prev' ? 2 : 0), 1);
    const newMonthKey = getMonthYear(newDate);
    const [currentYear, currentMonthNum] = currentMonth.split('-').map(Number);
    if (newDate.getFullYear() > currentYear || (newDate.getFullYear() === currentYear && newDate.getMonth() + 1 > currentMonthNum)) return;
    setViewedMonth(newMonthKey);
  };

   const fileToGenerativePart = async (file: File) => {
    const base64EncodedDataPromise = new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
      reader.readAsDataURL(file);
    });
    return {
      inlineData: { data: await base64EncodedDataPromise, mimeType: file.type },
    };
  };

   const handleSendMessage = async (userInput: string, images?: File[]) => {
    setIsLoading(true);

    const imageParts = images ? await Promise.all(images.map(fileToGenerativePart)) : [];
    const imageUrls = images ? images.map(file => URL.createObjectURL(file)) : [];

    setChatHistory(prev => [...prev, { role: 'user', text: userInput, images: imageUrls }]);

    // Create a summary of expenses to reduce prompt size
    const expenseSummary = expenses.reduce((acc, expense) => {
        acc[expense.category] = (acc[expense.category] || 0) + expense.amount;
        return acc;
    }, {} as Record<string, number>);

    const currentState = {
      budgets,
      expenseSummary,
      viewedMonth,
      currentMonth,
    };

    let prompt;
    if (pendingAction) {
        prompt = `
          Contexto: O usuário está respondendo a uma pergunta de confirmação.
          Ação pendente: ${JSON.stringify(pendingAction)}
          Estado atual: ${JSON.stringify(currentState)}
          Mensagem do usuário: "${userInput}"
        `;
    } else {
        prompt = `
          Estado atual: ${JSON.stringify(currentState)}
          Mensagem do usuário: "${userInput}"
        `;
    }

    try {
      const contents = [
        ...imageParts,
        { text: prompt }
      ];

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: contents,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: 'application/json',
        },
      });

      const aiResponseText = response.text;
      const aiResponseJson = JSON.parse(aiResponseText);
      
      const { action, payload, response: textResponse } = aiResponseJson;

      switch (action) {
        case 'CONFIRM_ACTION':
          setPendingAction(payload);
          break;
        case 'SET_BUDGET':
          setBudgets(prev => ({ ...prev, ...payload }));
          setPendingAction(null);
          break;
        case 'ADD_EXPENSE':
          const newExpenses: Expense[] = payload.map((exp: { category: string, amount: number }) => ({
            ...exp,
            date: new Date().toISOString(),
          }));
          setExpenses(prev => [...prev, ...newExpenses]);
          setPendingAction(null);
          break;
        case 'NEXT_MONTH':
            const [year, month] = viewedMonth.split('-').map(Number);
            const nextDate = new Date(year, month, 1);
            const newMonthKey = `${nextDate.getFullYear()}-${nextDate.getMonth() + 1}`;
            
            if (payload.copyBudgets) {
              const currentBudgets = localStorage.getItem(`budgets_${viewedMonth}`);
              if(currentBudgets) {
                  localStorage.setItem(`budgets_${newMonthKey}`, currentBudgets);
              }
            }
            setViewedMonth(newMonthKey);
            setCurrentMonth(newMonthKey); // Also update the current month context
            setPendingAction(null);
            break;
        case 'VIEW_PREVIOUS_MONTH':
            const { year: pYear, month: pMonth } = payload;
            setViewedMonth(`${pYear}-${pMonth}`);
            setPendingAction(null);
            break;
        case 'CLEAR_ALL_DATA':
          // Limpar todos os dados do localStorage
          const keysToRemove = [];
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && (key.startsWith('budgets_') || key.startsWith('expenses_'))) {
              keysToRemove.push(key);
            }
          }
          keysToRemove.forEach(key => localStorage.removeItem(key));
          
          // Resetar o estado da aplicação
          setBudgets({});
          setExpenses([]);
          setChatHistory([{ role: 'model', text: 'Olá! Sou seu assistente financeiro.' }]);
          
          // Voltar para o mês atual
          const currentMonthKey = getMonthYear();
          setViewedMonth(currentMonthKey);
          setCurrentMonth(currentMonthKey);
          setPendingAction(null);
          break;
        case 'DELETE_CATEGORY':
          // Excluir uma categoria específica
          const { category: categoryToDelete } = payload;
          
          // Remover a categoria dos orçamentos
          const updatedBudgets = { ...budgets };
          delete updatedBudgets[categoryToDelete];
          setBudgets(updatedBudgets);
          
          // Remover os gastos da categoria
          const updatedExpenses = expenses.filter(expense => expense.category.toLowerCase() !== categoryToDelete.toLowerCase());
          setExpenses(updatedExpenses);
          setPendingAction(null);
          break;
        case 'CANCEL_ACTION':
          setPendingAction(null);
          break;
        case 'GREETING':
        case 'UNKNOWN':
        default:
          setPendingAction(null);
          break;
      }

      setChatHistory(prev => [...prev, { role: 'model', text: textResponse }]);

    } catch (error) {
      console.error("Error calling Gemini API:", error);
      const errorMessage = "Desculpe, não consegui processar sua solicitação. Tente novamente.";
      setChatHistory(prev => [...prev, { role: 'model', text: errorMessage }]);
      setPendingAction(null);
    } finally {
      setIsLoading(false);
    }
  };

  const renderMainView = () => {
    switch (mainView) {
      case 'summary': return <SummaryView budgets={budgets} expenses={expenses} viewedMonth={viewedMonth} />;
      case 'entries': return <ExpenseList expenses={expenses} />;
      case 'assistant': return <AssistantView messages={chatHistory} onSendMessage={handleSendMessage} isLoading={isLoading} />;
      default: return null;
    }
  };

  return (
    <div className="app-container">
      <AppHeader viewedMonth={viewedMonth} onMonthChange={handleMonthChange} currentMonth={currentMonth} />
      <SegmentedControl selected={mainView} onSelect={setMainView} />
      <main className="main-content">{renderMainView()}</main>
      {/* <FloatingActionButton onClick={() => alert('Adicionar novo lançamento')} /> */}
    </div>
  );
}

// --- SERVICE WORKER & RENDER ---
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(console.error);
  });
}

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(<App />);
