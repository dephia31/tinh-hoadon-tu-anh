import { useState, useRef, useCallback, useEffect } from 'react';
import { Camera, Upload, Image as ImageIcon, Loader2, Calculator, RefreshCw, Trash2, History, X, CheckCircle2, AlertCircle, LogIn, LogOut, Save, Edit3, FileSpreadsheet, Maximize2, ZoomIn, Settings, Key } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { GoogleGenAI, Type } from "@google/genai";
import { cn } from './lib/utils';
import * as XLSX from 'xlsx';

// Firebase imports
import { auth, db } from './firebase';
import { 
  signInWithPopup, 
  GoogleAuthProvider, 
  onAuthStateChanged, 
  signOut,
  User
} from 'firebase/auth';
import { 
  collection, 
  addDoc, 
  query, 
  where, 
  onSnapshot, 
  orderBy, 
  deleteDoc, 
  doc, 
  updateDoc,
  serverTimestamp,
  getDocFromServer
} from 'firebase/firestore';

// Initialize Gemini helper
const getAI = (manualKey?: string, serverKey?: string | null) => {
  let apiKey = '';
  
  const isValid = (key: any) => typeof key === 'string' && key.length > 10 && key !== 'undefined' && key !== 'null';

  // 1. Try manual key from settings
  if (isValid(manualKey)) {
    apiKey = manualKey!;
  }
  
  // 2. Try server-provided key (from process.env on server)
  if (!apiKey && isValid(serverKey)) {
    apiKey = serverKey!;
  }

  // 3. Try process.env in frontend (if injected by build)
  if (!apiKey) {
    try {
      // @ts-ignore
      const envKey = process.env.GEMINI_API_KEY;
      // @ts-ignore
      const pKey = process.env.API_KEY;
      if (isValid(envKey)) apiKey = envKey;
      else if (isValid(pKey)) apiKey = pKey;
    } catch (e) {}
  }

  // 4. Try Vite env vars
  if (!apiKey) {
    try {
      const vGemini = (import.meta as any).env?.VITE_GEMINI_API_KEY;
      const vApi = (import.meta as any).env?.VITE_API_KEY;
      if (isValid(vGemini)) apiKey = vGemini;
      else if (isValid(vApi)) apiKey = vApi;
    } catch (e) {}
  }

  if (!apiKey) {
    console.warn("No valid API Key found.");
    return null;
  }
  
  return new GoogleGenAI({ apiKey });
};

// Type definition for AI Studio window API
declare global {
  interface Window {
    aistudio?: {
      hasSelectedApiKey: () => Promise<boolean>;
      openSelectKey: () => Promise<void>;
    };
  }
}

interface HistoryItem {
  id: string;
  uid: string;
  image?: string;
  images?: string[];
  result: string;
  correction?: string;
  timestamp: number;
}

interface Adjustment {
  description: string;
  type: 'add' | 'subtract';
  amount: number;
}

interface InvoiceData {
  isCorrect: boolean;
  items: {
    name: string;
    quantity: number;
    unitPrice: number;
    calculatedTotal: number;
    billTotal?: number;
    isCorrect: boolean;
  }[];
  summary: {
    billTotal: number;
    calculatedTotal: number;
    adjustments: Adjustment[];
    finalCalculatedTotal: number;
    finalBillTotal?: number;
  };
}

const formatCurrency = (amount: number) => {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount).replace('₫', 'đ');
};

const InvoiceResultRenderer = ({ data, onChange }: { data: string, onChange?: (newData: string) => void }) => {
  let invoiceData: InvoiceData | null = null;
  
  try {
    // Try to parse as JSON
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === 'object' && 'items' in parsed && 'summary' in parsed) {
      invoiceData = parsed;
    }
  } catch (e) {
    // Not JSON, fallback to Markdown
  }

  const handleItemChange = (idx: number, field: 'name' | 'quantity' | 'unitPrice', value: string) => {
    if (!invoiceData || !onChange) return;
    
    const newData = JSON.parse(JSON.stringify(invoiceData)) as InvoiceData;
    
    if (field === 'name') {
      newData.items[idx][field] = value;
    } else {
      const numValue = parseFloat(value) || 0;
      newData.items[idx][field] = numValue;
    }
    
    // Recalculate item total
    newData.items[idx].calculatedTotal = newData.items[idx].quantity * newData.items[idx].unitPrice;
    
    // Check if it matches billTotal
    if (newData.items[idx].billTotal !== undefined) {
      newData.items[idx].isCorrect = newData.items[idx].calculatedTotal === newData.items[idx].billTotal;
    }

    // Recalculate summary totals
    newData.summary.calculatedTotal = newData.items.reduce((sum, item) => sum + item.calculatedTotal, 0);
    
    // Recalculate final total
    let finalCalc = newData.summary.calculatedTotal;
    newData.summary.adjustments.forEach(adj => {
      if (adj.type === 'add') finalCalc += adj.amount;
      else if (adj.type === 'subtract') finalCalc -= adj.amount;
    });
    newData.summary.finalCalculatedTotal = finalCalc;

    // Recalculate overall isCorrect
    const isSubTotalCorrect = newData.summary.billTotal === undefined || newData.summary.calculatedTotal === newData.summary.billTotal;
    const isFinalTotalCorrect = newData.summary.finalBillTotal === undefined || newData.summary.finalCalculatedTotal === newData.summary.finalBillTotal;
    const isItemsCorrect = newData.items.every(item => item.isCorrect);

    newData.isCorrect = isItemsCorrect && isSubTotalCorrect && isFinalTotalCorrect;

    onChange(JSON.stringify(newData, null, 2));
  };

  if (!invoiceData) {
    return (
      <div className="overflow-x-auto pb-4">
        <div className="prose prose-slate max-w-none prose-table:w-full prose-table:border-separate prose-table:border-spacing-0 prose-table:border prose-table:border-white/60 prose-table:rounded-[24px] prose-table:overflow-hidden prose-table:shadow-sm prose-th:bg-white/60 prose-th:text-[#1D1D1F] prose-th:font-semibold prose-th:p-4 prose-th:text-left prose-th:border-b prose-th:border-white/60 prose-td:p-4 prose-td:border-b prose-td:border-white/40 prose-tr:last:prose-td:border-0 hover:prose-tr:bg-white/30 transition-colors min-w-[500px]">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{data}</ReactMarkdown>
        </div>
      </div>
    );
  }

  const isSubTotalCorrect = invoiceData.summary.calculatedTotal === invoiceData.summary.billTotal;
  const isFinalTotalCorrect = invoiceData.summary.finalBillTotal === undefined || invoiceData.summary.finalCalculatedTotal === invoiceData.summary.finalBillTotal;

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Status Banner */}
      <div className={cn(
        "px-4 py-4 sm:px-6 sm:py-5 rounded-[20px] sm:rounded-[24px] flex items-center gap-3 font-black text-base sm:text-lg tracking-tight",
        invoiceData.isCorrect ? "bg-[#F4FBF7] text-[#1E8E3E]" : "bg-[#FEF2F2] text-[#B91C1C]"
      )}>
        {invoiceData.isCorrect ? <CheckCircle2 size={24} className="sm:w-7 sm:h-7" strokeWidth={2.5} /> : <AlertCircle size={24} className="sm:w-7 sm:h-7" strokeWidth={2.5} />}
        {invoiceData.isCorrect ? "HÓA ĐƠN CHÍNH XÁC" : "HÓA ĐƠN CÓ SAI SÓT"}
      </div>

      {/* Items List */}
      <div className="bg-white rounded-[24px] sm:rounded-[32px] shadow-sm border border-gray-100 overflow-hidden">
        <div className="divide-y divide-gray-100/80 px-2">
          {invoiceData.items.map((item, idx) => (
            <div key={idx} className="p-4 sm:p-6 flex justify-between items-start gap-3 sm:gap-4 hover:bg-gray-50/50 transition-colors rounded-2xl my-1">
              <div className="space-y-1 sm:space-y-1.5 min-w-0 flex-1">
                {onChange ? (
                  <input
                    type="text"
                    value={item.name}
                    onChange={(e) => handleItemChange(idx, 'name', e.target.value)}
                    className="font-bold text-[#1D1D1F] text-[15px] sm:text-base leading-snug w-full bg-transparent border-b border-dashed border-gray-300 focus:border-indigo-500 outline-none pb-0.5"
                    placeholder="Tên hàng hóa"
                  />
                ) : (
                  <h3 className="font-bold text-[#1D1D1F] text-[15px] sm:text-base leading-snug break-words">{item.name}</h3>
                )}
                {onChange ? (
                  <div className="flex items-center gap-2 mt-1.5">
                    <input 
                      type="number" 
                      value={item.quantity} 
                      onChange={(e) => handleItemChange(idx, 'quantity', e.target.value)}
                      className="w-16 px-2 py-1 text-[13px] border border-gray-200 rounded-md focus:ring-1 focus:ring-indigo-500 outline-none bg-gray-50/50"
                      min="0"
                      step="any"
                    />
                    <span className="text-[13px] text-[#86868B] font-medium">x</span>
                    <input 
                      type="number" 
                      value={item.unitPrice} 
                      onChange={(e) => handleItemChange(idx, 'unitPrice', e.target.value)}
                      className="w-24 px-2 py-1 text-[13px] border border-gray-200 rounded-md focus:ring-1 focus:ring-indigo-500 outline-none bg-gray-50/50"
                      min="0"
                      step="any"
                    />
                  </div>
                ) : (
                  <p className="text-[13px] text-[#86868B] font-medium">
                    {item.quantity} x {formatCurrency(item.unitPrice)}
                  </p>
                )}
                {!item.isCorrect && item.billTotal !== undefined && (
                  <p className="text-xs text-red-600 font-medium bg-red-50 inline-block px-2 py-1 rounded-md mt-1.5 border border-red-100">
                    Lệch: {formatCurrency(item.calculatedTotal - item.billTotal)}
                  </p>
                )}
              </div>
              <div className="text-right shrink-0 flex flex-col items-end justify-start">
                <span className={cn(
                  "font-bold text-base sm:text-lg tracking-tight leading-none",
                  item.isCorrect ? "text-[#1D1D1F]" : "text-red-600"
                )}>
                  {formatCurrency(item.calculatedTotal)}
                </span>
                {!item.isCorrect && item.billTotal !== undefined && (
                  <span className="text-[11px] sm:text-xs text-[#86868B] line-through mt-1.5 font-medium">
                    {formatCurrency(item.billTotal)}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Summary Section */}
        <div className="p-5 sm:p-8 space-y-4">
          <div className="h-px bg-gray-100 w-full mb-4 sm:mb-6" />
          <div className="flex justify-between items-center text-[14px] sm:text-[15px] font-medium text-[#86868B]">
            <span>Cộng tiền hàng (ghi trên bill):</span>
            <span className={!isSubTotalCorrect ? "line-through" : ""}>{formatCurrency(invoiceData.summary.billTotal)}</span>
          </div>
          
          <div className="flex justify-between items-center">
            <span className="text-lg sm:text-xl font-black text-[#0066CC] tracking-tight">Cộng tiền hàng (tính lại):</span>
            <span className="text-2xl sm:text-3xl font-black text-[#0066CC] tracking-tight">
              {formatCurrency(invoiceData.summary.calculatedTotal)}
            </span>
          </div>

          {!isSubTotalCorrect && (
            <div className="flex justify-between items-center mt-2 p-3 bg-red-50 border border-red-100 rounded-xl">
              <span className="text-sm font-bold text-red-700">Lệch tiền hàng:</span>
              <span className="text-base font-bold text-red-700">
                {formatCurrency(invoiceData.summary.calculatedTotal - invoiceData.summary.billTotal)}
              </span>
            </div>
          )}

          {invoiceData.summary.adjustments && invoiceData.summary.adjustments.length > 0 && (
            <>
              <div className="h-px bg-gray-100 w-full my-4 sm:my-6" />
              {invoiceData.summary.adjustments.map((adj, idx) => (
                <div key={idx} className={cn("flex justify-between items-center text-[14px] sm:text-[15px] font-medium mb-2", adj.type === 'add' ? "text-[#86868B]" : "text-[#34C759]")}>
                  <span>{adj.description || (adj.type === 'add' ? 'Cộng thêm' : 'Trừ đi')}:</span>
                  <span>{adj.type === 'add' ? '+' : '-'}{formatCurrency(adj.amount)}</span>
                </div>
              ))}
              
              <div className="h-px bg-gray-100 w-full my-4 sm:my-6" />
              {invoiceData.summary.finalBillTotal !== undefined && (
                <div className="flex justify-between items-center text-[14px] sm:text-[15px] font-medium text-[#86868B]">
                  <span>Tổng cộng cuối (ghi trên bill):</span>
                  <span className={!isFinalTotalCorrect ? "line-through" : ""}>{formatCurrency(invoiceData.summary.finalBillTotal)}</span>
                </div>
              )}
              <div className="flex justify-between items-center mt-1 sm:mt-2">
                <span className="text-lg sm:text-xl font-black text-[#FF3B30] tracking-tight">Tổng cộng cuối (tính lại):</span>
                <span className="text-2xl sm:text-3xl font-black text-[#FF3B30] tracking-tight">
                  {formatCurrency(invoiceData.summary.finalCalculatedTotal)}
                </span>
              </div>
              {!isFinalTotalCorrect && invoiceData.summary.finalBillTotal !== undefined && (
                <div className="flex justify-between items-center mt-2 p-3 bg-red-50 border border-red-100 rounded-xl">
                  <span className="text-sm font-bold text-red-700">Lệch tổng cuối:</span>
                  <span className="text-base font-bold text-red-700">
                    {formatCurrency(invoiceData.summary.finalCalculatedTotal - invoiceData.summary.finalBillTotal)}
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: any;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [images, setImages] = useState<string[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [correction, setCorrection] = useState<string>('');
  const [isSavingCorrection, setIsSavingCorrection] = useState(false);
  const [currentHistoryId, setCurrentHistoryId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [showInstallGuide, setShowInstallGuide] = useState(false);
  const [hasAIStudioKey, setHasAIStudioKey] = useState<boolean | null>(null);
  const [serverKey, setServerKey] = useState<string | null>(null);

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const res = await fetch('/api/config');
        const data = await res.json();
        if (data.apiKey) {
          setServerKey(data.apiKey);
          setHasAIStudioKey(true);
        } else {
          // Fallback to AI Studio window API if server doesn't have it
          if (window.aistudio) {
            const hasKey = await window.aistudio.hasSelectedApiKey();
            setHasAIStudioKey(hasKey);
          } else {
            setHasAIStudioKey(false);
          }
        }
      } catch (e) {
        console.error("Error fetching config:", e);
      }
    };
    fetchConfig();
  }, []);

  const handleOpenAIStudioKey = async () => {
    if (window.aistudio) {
      try {
        await window.aistudio.openSelectKey();
        setHasAIStudioKey(true);
      } catch (e) {
        console.error("Error opening AI Studio key dialog:", e);
      }
    }
  };
  const [showHistory, setShowHistory] = useState(false);
  const [zoomedImage, setZoomedImage] = useState<string | null>(null);
  const [manualKey, setManualKey] = useState<string>(() => localStorage.getItem('manquy_api_key') || '');
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  // Error handling helper
  const handleFirestoreError = (error: unknown, operationType: OperationType, path: string | null) => {
    const errInfo: FirestoreErrorInfo = {
      error: error instanceof Error ? error.message : String(error),
      authInfo: {
        userId: auth.currentUser?.uid,
        email: auth.currentUser?.email,
        emailVerified: auth.currentUser?.emailVerified,
      },
      operationType,
      path
    };
    console.error('Firestore Error: ', JSON.stringify(errInfo));
    setError(`Lỗi cơ sở dữ liệu: ${errInfo.error}`);
  };

  // Auth listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUser(user);
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  // Test connection to Firestore
  useEffect(() => {
    if (isAuthReady && user) {
      const testConnection = async () => {
        try {
          await getDocFromServer(doc(db, 'test', 'connection'));
        } catch (error) {
          if (error instanceof Error && error.message.includes('the client is offline')) {
            console.error("Please check your Firebase configuration.");
            setError("Không thể kết nối với cơ sở dữ liệu. Vui lòng kiểm tra cấu hình.");
          }
        }
      };
      testConnection();
    }
  }, [isAuthReady, user]);

  // Load history from Firestore
  useEffect(() => {
    if (!isAuthReady || !user) {
      setHistory([]);
      return;
    }

    const q = query(
      collection(db, 'history'),
      where('uid', '==', user.uid),
      orderBy('timestamp', 'desc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const items: HistoryItem[] = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        items.push({
          id: doc.id,
          ...data,
          timestamp: data.timestamp?.toMillis?.() || data.timestamp || Date.now()
        } as HistoryItem);
      });
      setHistory(items);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'history');
    });

    return () => unsubscribe();
  }, [isAuthReady, user]);

  const login = async () => {
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (err: any) {
      console.error("Login error:", err);
      if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') {
        // Ignore benign errors when the user closes the popup or a request is cancelled
        return;
      }
      setError("Không thể đăng nhập. Vui lòng thử lại.");
    }
  };

  const logout = async () => {
    try {
      await signOut(auth);
      reset();
    } catch (err) {
      console.error("Logout error:", err);
    }
  };

  // Compress image helper
  const compressImage = (file: File | string): Promise<string> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = typeof file === 'string' ? file : URL.createObjectURL(file);
      
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 1200;
        const MAX_HEIGHT = 1200;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height *= MAX_WIDTH / width;
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width *= MAX_HEIGHT / height;
            height = MAX_HEIGHT;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error("Không thể tạo bộ xử lý ảnh (Canvas context)"));
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        
        // Cleanup object URL
        if (typeof file !== 'string') URL.revokeObjectURL(url);
        
        // Compress to JPEG with 0.6 quality to stay well under 1MB
        resolve(canvas.toDataURL('image/jpeg', 0.6));
      };

      img.onerror = () => {
        if (typeof file !== 'string') URL.revokeObjectURL(url);
        reject(new Error("Không thể tải ảnh. Vui lòng kiểm tra định dạng tệp."));
      };

      img.src = url;
    });
  };

  // Handle File Upload
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const newImages: string[] = [];
      setError(null);
      
      for (let i = 0; i < files.length; i++) {
        try {
          const file = files[i];
          const compressed = await compressImage(file);
          newImages.push(compressed);
        } catch (err) {
          console.error("File processing error:", err);
          setError(`Lỗi xử lý tệp ${i + 1}: ${err instanceof Error ? err.message : "Không xác định"}`);
        }
      }
      
      if (newImages.length > 0) {
        setImages(prev => [...prev, ...newImages]);
        setResult(null);
      }
    }
  };

  // Analyze Images with Gemini
  const analyzeImage = async () => {
    if (images.length === 0) return;
    
    const aiInstance = getAI(manualKey, serverKey);
    if (!aiInstance) {
      setError("Vui lòng chọn API Key (nút màu vàng ở trên) hoặc nhập Key trong phần Cài đặt.");
      setIsAnalyzing(false);
      return;
    }

    setIsAnalyzing(true);
    setError(null);

    try {
      const parts: any[] = [
        {
          text: `Hãy trích xuất chính xác các con số được viết trên hình ảnh hóa đơn này.
          YÊU CẦU QUAN TRỌNG:
          1. Bỏ qua thông tin cửa hàng, địa chỉ, số điện thoại.
          2. CHỈ TRÍCH XUẤT, KHÔNG TỰ TÍNH TOÁN LẠI. Nếu trên giấy viết sai toán học (ví dụ 20 x 85 = 1100), bạn BẮT BUỘC phải trích xuất đúng con số 1100 đã viết trên giấy vào trường 'amountWritten'. KHÔNG ĐƯỢC tự sửa thành 1700.
          3. Trích xuất các mặt hàng: Tên, Số lượng, Đơn giá, và Thành tiền (con số ghi ở cuối mỗi dòng).
          4. Trích xuất phần Tổng cộng:
             - 'subTotalWritten': Tổng tiền hàng hóa (kết quả cộng các dòng hàng).
             - 'adjustments': Các dòng cộng/trừ thêm bên dưới tổng tiền hàng (ví dụ: + 12.160 nợ cũ, hoặc - 500 trả trước).
             - 'finalTotalWritten': Tổng cộng cuối cùng ghi trên giấy (sau khi đã cộng/trừ các khoản ở trên).
          5. Trả về JSON theo đúng schema.`,
        }
      ];

      for (const img of images) {
        const base64Data = img.split(',')[1];
        const mimeType = img.split(';')[0].split(':')[1];
        parts.push({
          inlineData: {
            mimeType: mimeType || "image/jpeg",
            data: base64Data,
          },
        });
      }
      
      const response = await aiInstance.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [{ parts }],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              items: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING, description: "Tên mặt hàng" },
                    quantity: { type: Type.NUMBER, description: "Số lượng" },
                    unitPrice: { type: Type.NUMBER, description: "Đơn giá" },
                    amountWritten: { type: Type.NUMBER, description: "Thành tiền GHI TRÊN GIẤY của dòng này (KHÔNG TỰ TÍNH)" }
                  },
                  required: ["name", "quantity", "unitPrice"]
                }
              },
              summary: {
                type: Type.OBJECT,
                properties: {
                  subTotalWritten: { type: Type.NUMBER, description: "Cộng tiền hàng GHI TRÊN GIẤY" },
                  adjustments: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        description: { type: Type.STRING, description: "Mô tả khoản cộng/trừ (vd: Nợ cũ, Ứng trước)" },
                        type: { type: Type.STRING, description: "'add' nếu là cộng thêm, 'subtract' nếu là trừ đi" },
                        amount: { type: Type.NUMBER, description: "Số tiền" }
                      },
                      required: ["type", "amount"]
                    }
                  },
                  finalTotalWritten: { type: Type.NUMBER, description: "Tổng cộng cuối cùng GHI TRÊN GIẤY" }
                }
              }
            },
            required: ["items", "summary"]
          }
        }
      });

      const rawDataText = response.text || "{}";
      let analysisResult = "";
      
      try {
        const rawData = JSON.parse(rawDataText);
        
        const processedItems = (rawData.items || []).map((item: any) => {
          const calculatedTotal = (item.quantity || 0) * (item.unitPrice || 0);
          const isItemCorrect = item.amountWritten === undefined || calculatedTotal === item.amountWritten;
          return {
            name: item.name || "Không rõ",
            quantity: item.quantity || 0,
            unitPrice: item.unitPrice || 0,
            calculatedTotal: calculatedTotal,
            billTotal: item.amountWritten,
            isCorrect: isItemCorrect
          };
        });

        const calculatedSubTotal = processedItems.reduce((sum: number, item: any) => sum + item.calculatedTotal, 0);

        const adjustments = rawData.summary?.adjustments || [];
        let calculatedFinalTotal = calculatedSubTotal;
        adjustments.forEach((adj: any) => {
          if (adj.type === 'add') calculatedFinalTotal += (adj.amount || 0);
          else if (adj.type === 'subtract') calculatedFinalTotal -= (adj.amount || 0);
        });

        const isSubTotalCorrect = rawData.summary?.subTotalWritten === undefined || calculatedSubTotal === rawData.summary.subTotalWritten;
        const isFinalTotalCorrect = rawData.summary?.finalTotalWritten === undefined || calculatedFinalTotal === rawData.summary.finalTotalWritten;
        const isItemsCorrect = processedItems.every((item: any) => item.isCorrect);

        const invoiceData: InvoiceData = {
          isCorrect: isItemsCorrect && isSubTotalCorrect && isFinalTotalCorrect,
          items: processedItems,
          summary: {
            billTotal: rawData.summary?.subTotalWritten || 0,
            calculatedTotal: calculatedSubTotal,
            adjustments: adjustments,
            finalCalculatedTotal: calculatedFinalTotal,
            finalBillTotal: rawData.summary?.finalTotalWritten
          }
        };

        analysisResult = JSON.stringify(invoiceData, null, 2);
      } catch (e) {
        console.error("Failed to process raw data", e);
        analysisResult = rawDataText;
      }

      setResult(analysisResult);
      setCorrection('');

      // Add to Firestore if user is logged in
      if (user) {
        try {
          // Store all images as an array in Firestore
          const docRef = await addDoc(collection(db, 'history'), {
            uid: user.uid,
            images: images, // Updated to store array
            result: analysisResult,
            timestamp: serverTimestamp(),
          });
          setCurrentHistoryId(docRef.id);
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, 'history');
        }
      }

    } catch (err) {
      console.error("Analysis error:", err);
      const errorMessage = err instanceof Error ? err.message : "Không xác định";
      if (errorMessage.includes("API key")) {
        setError("Lỗi API Key: Vui lòng kiểm tra lại cấu hình trong AI Studio.");
      } else if (errorMessage.includes("quota") || errorMessage.includes("spending cap") || errorMessage.includes("RESOURCE_EXHAUSTED") || errorMessage.includes("429")) {
        setError("Hết hạn mức sử dụng API (Spending cap exceeded). Vui lòng cập nhật API Key mới trong phần Cài đặt hoặc kiểm tra lại thanh toán Google Cloud của bạn.");
      } else {
        setError(`Lỗi phân tích: ${errorMessage}`);
      }
    } finally {
      setIsAnalyzing(false);
    }
  };

  const saveCorrection = async () => {
    if (!user || !currentHistoryId) return;
    
    setIsSavingCorrection(true);
    try {
      const updateData: any = { result };
      if (correction.trim()) {
        updateData.correction = correction;
      }
      
      await updateDoc(doc(db, 'history', currentHistoryId), updateData);
      // Update local state for immediate feedback
      setHistory(prev => prev.map(item => 
        item.id === currentHistoryId ? { ...item, correction, result } : item
      ));
      setError(null);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `history/${currentHistoryId}`);
    } finally {
      setIsSavingCorrection(false);
    }
  };

  const deleteHistoryItem = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!user) return;
    
    try {
      await deleteDoc(doc(db, 'history', id));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `history/${id}`);
    }
  };

  const reset = () => {
    setImages([]);
    setResult(null);
    setCorrection('');
    setCurrentHistoryId(null);
    setError(null);
  };

  const selectHistoryItem = (item: HistoryItem) => {
    if (item.images) {
      setImages(item.images);
    } else if ((item as any).image) {
      setImages([(item as any).image]);
    }
    setResult(item.result);
    setCorrection(item.correction || '');
    setCurrentHistoryId(item.id);
    setError(null);
    setShowHistory(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const exportToExcel = () => {
    if (!result) return;

    try {
      const lines = result.split('\n');
      const data: string[][] = [];
      
      lines.forEach(line => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return;

        // Check if it's a summary line with ":"
        if (trimmed.includes(':')) {
          const parts = trimmed.split(':').map(p => p.trim());
          data.push([parts[0], parts.slice(1).join(':')]);
        } 
        // Check if it's an item line like "Qty x Item x Price = Result"
        else if (trimmed.includes(' x ') && trimmed.includes(' = ')) {
          data.push([trimmed]);
        }
        // Otherwise just add the line
        else {
          data.push([trimmed]);
        }
      });

      if (data.length < 1) {
        setError("Không tìm thấy dữ liệu để xuất Excel.");
        return;
      }

      const ws = XLSX.utils.aoa_to_sheet(data);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "KetQuaPhanTich");
      
      const fileName = `Man_Quy_Export_${new Date().getTime()}.xlsx`;
      XLSX.writeFile(wb, fileName);
    } catch (err) {
      console.error("Excel export error:", err);
      setError("Lỗi khi xuất file Excel. Vui lòng thử lại.");
    }
  };

  return (
    <div className="min-h-screen bg-[#F5F5F7] text-[#1D1D1F] font-sans selection:bg-indigo-200">
      {/* iOS Install Guide */}
      <AnimatePresence>
        {showInstallGuide && (
          <motion.div
            initial={{ y: -100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -100, opacity: 0 }}
            className="fixed top-0 left-0 right-0 z-50 p-4 glass-panel-dark text-white"
          >
            <div className="max-w-4xl mx-auto flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-white/10 rounded-[20px] flex items-center justify-center shrink-0">
                  <Upload size={20} strokeWidth={1.5} className="rotate-180" />
                </div>
                <div className="text-sm">
                  <p className="font-bold">Cài đặt Mận Quý trên iPhone</p>
                  <p className="opacity-70">Nhấn nút <span className="font-bold">Chia sẻ</span> rồi chọn <span className="font-bold">"Thêm vào MH chính"</span></p>
                </div>
              </div>
              <button 
                onClick={() => setShowInstallGuide(false)}
                className="p-2 hover:bg-white/10 rounded-full transition-colors"
              >
                <X size={20} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <header className="glass-panel sticky top-0 z-20 border-b-0 border-white/40">
        <div className="max-w-4xl mx-auto px-3 py-3 sm:px-6 sm:py-4 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0 shrink-0">
            <div className="w-8 h-8 sm:w-10 sm:h-10 bg-gradient-primary rounded-[16px] sm:rounded-[20px] flex items-center justify-center text-white shadow-[0_8px_16px_rgba(99,102,241,0.2)] shrink-0">
              <Calculator size={18} className="sm:w-[22px] sm:h-[22px]" strokeWidth={1.5} />
            </div>
            <h1 className="text-base sm:text-xl font-semibold tracking-tight truncate hidden xs:block">Tính Toán</h1>
          </div>
          <div className="flex items-center gap-1 sm:gap-2 shrink-0">
            {serverKey ? (
              <div className="flex items-center gap-1.5 px-2 py-1.5 sm:px-4 sm:py-2 bg-green-500/10 text-green-700 rounded-full text-[11px] sm:text-xs font-medium border border-green-500/20 backdrop-blur-md" title="Hệ thống đã kết nối">
                <CheckCircle2 size={14} strokeWidth={1.5} />
                <span className="hidden sm:inline">Hệ thống đã kết nối</span>
              </div>
            ) : hasAIStudioKey === false && window.aistudio && (
              <button
                onClick={handleOpenAIStudioKey}
                className="flex items-center gap-1.5 sm:gap-2 px-2 py-1.5 sm:px-4 sm:py-2 bg-amber-500/10 text-amber-700 rounded-full text-[12px] sm:text-sm font-medium hover:bg-amber-500/20 transition-all border border-amber-500/20 backdrop-blur-md active:scale-[0.97]"
                title="Chọn API Key"
              >
                <Key size={14} className="sm:w-4 sm:h-4" strokeWidth={1.5} />
                <span className="hidden sm:inline">Chọn API Key</span>
              </button>
            )}
            <button
              onClick={() => setShowSettings(true)}
              className={cn(
                "flex items-center gap-1.5 sm:gap-2 px-2 py-1.5 sm:px-4 sm:py-2 rounded-full text-[12px] sm:text-sm font-medium transition-all border backdrop-blur-md active:scale-[0.97]",
                manualKey 
                  ? "bg-indigo-500/10 text-indigo-700 border-indigo-500/20 hover:bg-indigo-500/20" 
                  : "bg-white/50 text-gray-700 border-white/60 hover:bg-white/80"
              )}
              title="Cấu hình API Key"
            >
              <Settings size={14} className="sm:w-4 sm:h-4" />
              <span className="hidden sm:inline">{manualKey ? 'Custom API' : 'Cấu hình API'}</span>
            </button>
            {user ? (
              <div className="flex items-center gap-1 sm:gap-3">
                <button
                  onClick={() => setShowHistory(true)}
                  className="p-1.5 sm:p-2 hover:bg-white/60 rounded-full transition-all text-[#666] relative active:scale-[0.97]"
                  title="Lịch sử"
                >
                  <History size={16} className="sm:w-5 sm:h-5" strokeWidth={1.5} />
                  {history.length > 0 && (
                    <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full border border-white" />
                  )}
                </button>
                <div className="flex items-center gap-1.5 sm:gap-2 pl-1.5 sm:pl-2 border-l border-gray-200/50">
                  <img src={user.photoURL || ''} alt={user.displayName || ''} className="w-7 h-7 sm:w-8 sm:h-8 rounded-full border border-white/60 shadow-sm" />
                  <button onClick={logout} className="p-1.5 sm:p-2 hover:bg-red-500/10 text-red-500 rounded-full transition-all active:scale-[0.97]" title="Đăng xuất">
                    <LogOut size={16} className="sm:w-5 sm:h-5" strokeWidth={1.5} />
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={login}
                className="flex items-center gap-1.5 sm:gap-2 px-3 py-1.5 sm:px-5 sm:py-2 bg-gradient-primary text-white rounded-full text-[12px] sm:text-sm font-medium transition-all shadow-[0_8px_16px_rgba(99,102,241,0.2)] active:scale-[0.97]"
              >
                <LogIn size={14} className="sm:w-[18px] sm:h-[18px]" strokeWidth={1.5} />
                <span className="hidden sm:inline">Đăng nhập</span>
              </button>
            )}
            {images.length > 0 && (
              <button
                onClick={reset}
                className="p-1.5 sm:p-2 hover:bg-white/60 rounded-full transition-all text-[#666] active:scale-[0.97]"
                title="Xóa tất cả"
              >
                <RefreshCw size={16} className="sm:w-5 sm:h-5" strokeWidth={1.5} />
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6 sm:px-6 sm:py-12">
        <div className="grid gap-8 sm:gap-12">
          {/* Action Area */}
          <section className="space-y-6 sm:space-y-8">
            <div className="text-center space-y-2">
              <h2 className="text-2xl sm:text-3xl font-bold tracking-tight md:text-4xl">Tính Toán Hóa Đơn</h2>
              <p className="text-[#666] max-w-lg mx-auto text-sm sm:text-base">
                Chào sếp Huy Đẹp Trai :) Chúc Sếp Ngày Mới Thành Công, Bán Hàng Đắt Khách
              </p>
            </div>

            {images.length === 0 ? (
              <div className="grid sm:grid-cols-2 gap-4">
                <motion.button
                  whileHover={{ y: -4 }}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => cameraInputRef.current?.click()}
                  className="flex flex-col items-center justify-center p-8 sm:p-12 glass-panel rounded-[24px] sm:rounded-[32px] hover:bg-white/80 transition-all group"
                >
                  <div className="w-14 h-14 sm:w-16 sm:h-16 bg-white/50 rounded-[20px] sm:rounded-[24px] shadow-sm flex items-center justify-center mb-3 sm:mb-4 group-hover:bg-gradient-primary group-hover:text-white transition-all duration-300">
                    <Camera size={28} className="sm:w-8 sm:h-8" strokeWidth={1.5} />
                  </div>
                  <span className="font-semibold text-base sm:text-lg tracking-tight">Chụp ảnh</span>
                  <span className="text-xs sm:text-sm text-[#666] mt-1">Sử dụng camera của bạn</span>
                  <input
                    type="file"
                    ref={cameraInputRef}
                    onChange={handleFileUpload}
                    accept="image/*"
                    capture="environment"
                    className="hidden"
                  />
                </motion.button>

                <motion.button
                  whileHover={{ y: -4 }}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => fileInputRef.current?.click()}
                  className="flex flex-col items-center justify-center p-8 sm:p-12 glass-panel rounded-[24px] sm:rounded-[32px] hover:bg-white/80 transition-all group"
                >
                  <div className="w-14 h-14 sm:w-16 sm:h-16 bg-white/50 rounded-[20px] sm:rounded-[24px] shadow-sm flex items-center justify-center mb-3 sm:mb-4 group-hover:bg-gradient-primary group-hover:text-white transition-all duration-300">
                    <Upload size={28} className="sm:w-8 sm:h-8" strokeWidth={1.5} />
                  </div>
                  <span className="font-semibold text-base sm:text-lg tracking-tight">Tải ảnh lên</span>
                  <span className="text-xs sm:text-sm text-[#666] mt-1">JPEG, PNG, BMP, GIF</span>
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleFileUpload}
                    multiple
                    accept="image/jpeg,image/png,image/bmp,image/gif"
                    className="hidden"
                  />
                </motion.button>
              </div>
            ) : null}

            {/* Image Preview & Analysis */}
            {images.length > 0 && (
              <div className="space-y-6">
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 sm:gap-4">
                  {images.map((img, index) => (
                    <div key={index} className="relative group cursor-pointer aspect-square sm:aspect-auto sm:h-32" onClick={() => setZoomedImage(img)}>
                      <div className="w-full h-full rounded-2xl overflow-hidden relative shadow-sm border border-[#E5E5E5]">
                        <img
                          src={img}
                          alt={`Preview ${index + 1}`}
                          className="w-full h-full object-cover hover:scale-105 transition-transform duration-300"
                        />
                        <div className="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                          <ZoomIn className="text-white" size={20} />
                        </div>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setImages(prev => prev.filter((_, i) => i !== index));
                        }}
                        className="absolute -top-2 -right-2 p-1.5 bg-white text-red-500 rounded-full shadow-lg border border-red-50 hover:bg-red-50 transition-colors z-10"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                  
                  {/* Add more button in grid */}
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="aspect-square sm:aspect-auto sm:h-32 w-full rounded-[24px] glass-panel flex flex-col items-center justify-center gap-2 text-[#666] hover:bg-white/80 transition-all active:scale-[0.97]"
                  >
                    <Upload size={24} strokeWidth={1.5} />
                    <span className="text-xs font-semibold tracking-tight">Thêm ảnh</span>
                  </button>
                </div>

                {/* Zoom Modal */}
                <AnimatePresence>
                  {zoomedImage && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-[40px] flex items-center justify-center p-4 md:p-10"
                      onClick={() => setZoomedImage(null)}
                    >
                      <motion.div
                        initial={{ scale: 0.9, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.9, opacity: 0 }}
                        className="relative max-w-full max-h-full"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <img
                          src={zoomedImage}
                          alt="Full Preview"
                          className="max-w-full max-h-[90vh] rounded-[32px] shadow-[0_40px_80px_rgba(0,0,0,0.4)]"
                        />
                        <button
                          onClick={() => setZoomedImage(null)}
                          className="absolute -top-16 right-0 p-4 text-white hover:text-white/70 transition-colors"
                        >
                          <X size={32} strokeWidth={1.5} />
                        </button>
                      </motion.div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {!result && (
                  <button
                    onClick={analyzeImage}
                    disabled={isAnalyzing}
                    className={cn(
                      "w-full py-4 sm:py-5 rounded-[24px] sm:rounded-[32px] font-semibold text-base sm:text-lg flex items-center justify-center gap-2 sm:gap-3 transition-all",
                      isAnalyzing
                        ? "bg-white/50 text-[#999] cursor-not-allowed backdrop-blur-md"
                        : "bg-gradient-primary text-white shadow-[0_8px_16px_rgba(99,102,241,0.2)] active:scale-[0.97]"
                    )}
                  >
                    {isAnalyzing ? (
                      <>
                        <Loader2 className="animate-spin" size={24} strokeWidth={1.5} />
                        Đang kiểm tra tính toán...
                      </>
                    ) : (
                      <>
                        <Calculator size={24} strokeWidth={1.5} />
                        Kiểm tra ngay
                      </>
                    )}
                  </button>
                )}
              </div>
            )}
          </section>

          {/* Results Area */}
          <AnimatePresence>
            {(result || error) && (
              <motion.section
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-6"
              >
                <div className="flex items-center gap-2 text-[#666] uppercase tracking-widest text-xs font-bold">
                  <div className="h-px flex-1 bg-[#E5E5E5]" />
                  <span>Báo cáo tính toán</span>
                  <div className="h-px flex-1 bg-[#E5E5E5]" />
                </div>

                {error ? (
                  <div className="p-6 bg-red-50 border border-red-100 rounded-3xl text-red-600 flex flex-col gap-4">
                    <div className="flex items-center gap-3">
                      <AlertCircle size={24} />
                      <div className="flex-1">
                        {error === "API_KEY_MISSING" ? (
                          <div className="space-y-2">
                            <p className="font-bold">Chưa cấu hình API Key</p>
                            <p className="text-sm opacity-90">Vui lòng nhấn nút bên dưới để chọn hoặc tạo API Key cho ứng dụng từ AI Studio.</p>
                          </div>
                        ) : (
                          <p>{error}</p>
                        )}
                      </div>
                      <button onClick={() => setError(null)} className="p-1 hover:bg-red-100 rounded-full transition-colors">
                        <X size={20} />
                      </button>
                    </div>
                    {error && (
                      <div className="space-y-4">
                        {error.includes("API Key") && window.aistudio && !serverKey ? (
                          <button
                            onClick={handleOpenAIStudioKey}
                            className="flex items-center justify-center gap-2 w-full py-3 bg-red-600 text-white rounded-xl font-bold hover:bg-red-700 transition-all shadow-md active:scale-95"
                          >
                            <Key size={18} />
                            Chọn API Key ngay
                          </button>
                        ) : error.includes("API Key") && !serverKey ? (
                          <div className="space-y-3 bg-white p-4 rounded-2xl border border-red-100 shadow-sm">
                            <p className="text-xs text-gray-500 font-medium">Bạn đang dùng bản chia sẻ. Vui lòng dán API Key Gemini của bạn để tiếp tục:</p>
                            <div className="flex gap-2">
                              <input
                                type="password"
                                value={manualKey}
                                onChange={(e) => {
                                  setManualKey(e.target.value);
                                  localStorage.setItem('manquy_api_key', e.target.value);
                                }}
                                placeholder="Dán API Key tại đây..."
                                className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-red-500 outline-none"
                              />
                              <button
                                onClick={() => {
                                  if (manualKey.trim()) {
                                    setError(null);
                                    analyzeImage();
                                  }
                                }}
                                className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-bold hover:bg-red-700"
                              >
                                Dùng Key này
                              </button>
                            </div>
                            <a 
                              href="https://aistudio.google.com/app/apikey" 
                              target="_blank" 
                              rel="noreferrer"
                              className="text-[10px] text-blue-600 hover:underline block text-center"
                            >
                              Chưa có Key? Lấy miễn phí tại đây (Google AI Studio)
                            </a>
                          </div>
                        ) : (
                          <div className="p-4 bg-red-50 text-red-700 rounded-2xl text-sm border border-red-100">
                            {error}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-4 sm:space-y-6">
                    <div className="glass-panel rounded-[24px] sm:rounded-[32px] p-4 sm:p-8 overflow-x-auto">
                      <InvoiceResultRenderer data={result!} onChange={setResult} />
                      <div className="mt-6 sm:mt-8 flex flex-wrap items-center justify-between gap-3 sm:gap-4">
                        <div className="flex items-center gap-2 text-indigo-600 font-medium text-[13px] sm:text-sm bg-indigo-500/10 px-3 py-1.5 sm:px-4 sm:py-2 rounded-full border border-indigo-500/20">
                          <CheckCircle2 size={16} strokeWidth={1.5} />
                          <span>Dữ liệu được phân tích bởi AI</span>
                        </div>
                        <button
                          onClick={exportToExcel}
                          className="flex items-center gap-2 px-5 py-2.5 sm:px-6 sm:py-3 bg-gradient-to-r from-teal-500 to-emerald-500 text-white rounded-full text-[13px] sm:text-sm font-semibold transition-all shadow-[0_8px_16px_rgba(16,185,129,0.2)] active:scale-[0.97]"
                        >
                          <FileSpreadsheet size={18} strokeWidth={1.5} />
                          Xuất Excel
                        </button>
                      </div>
                    </div>

                    {/* Correction Area */}
                    <div className="glass-panel rounded-[24px] sm:rounded-[32px] p-5 sm:p-8 space-y-4 sm:space-y-5">
                      <div className="flex items-center gap-2 text-[13px] sm:text-sm font-semibold uppercase tracking-wider text-[#666]">
                        <Edit3 size={18} strokeWidth={1.5} />
                        <span>Ghi chú & Lưu thay đổi</span>
                      </div>
                      <p className="text-xs text-[#86868B]">
                        Bạn có thể chỉnh sửa trực tiếp số lượng và đơn giá ở bảng trên. Thêm ghi chú nếu cần và bấm lưu.
                      </p>
                      <textarea
                        value={correction}
                        onChange={(e) => setCorrection(e.target.value)}
                        placeholder="Nhập các dòng nhận dạng sai hoặc ghi chú bổ sung tại đây..."
                        className="w-full h-24 sm:h-32 p-4 sm:p-5 bg-white/50 border border-white/60 rounded-[20px] sm:rounded-[24px] backdrop-blur-md focus:ring-2 focus:ring-indigo-500/50 focus:border-transparent transition-all outline-none resize-none shadow-inner text-sm"
                      />
                      <button
                        onClick={saveCorrection}
                        disabled={isSavingCorrection || !user || !currentHistoryId}
                        className={cn(
                          "flex items-center justify-center gap-2 w-full sm:w-auto px-6 py-3 sm:px-8 sm:py-4 rounded-full font-semibold transition-all active:scale-[0.97] text-sm",
                          isSavingCorrection || !user || !currentHistoryId
                            ? "bg-white/50 text-[#999] cursor-not-allowed backdrop-blur-md"
                            : "bg-gradient-primary text-white shadow-[0_8px_16px_rgba(99,102,241,0.2)]"
                        )}
                      >
                        {isSavingCorrection ? (
                          <Loader2 className="animate-spin" size={20} strokeWidth={1.5} />
                        ) : (
                          <Save size={20} strokeWidth={1.5} />
                        )}
                        Lưu thay đổi
                      </button>
                      {!user && (
                        <p className="text-xs text-amber-600 flex items-center gap-1.5 bg-amber-500/10 p-3 rounded-xl border border-amber-500/20">
                          <AlertCircle size={14} strokeWidth={1.5} />
                          Vui lòng đăng nhập để lưu hiệu chỉnh vào cơ sở dữ liệu.
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </motion.section>
            )}
          </AnimatePresence>
        </div>
      </main>

      {/* Settings Modal */}
      <AnimatePresence>
        {showSettings && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowSettings(false)}
              className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[60]"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[calc(100%-2rem)] max-w-md glass-panel z-[70] rounded-[32px] overflow-hidden flex flex-col max-h-[90vh]"
            >
              <div className="p-4 sm:p-6 border-b border-white/40 flex items-center justify-between bg-white/40 backdrop-blur-md shrink-0">
                <div className="flex items-center gap-2">
                  <Key className="text-[#1D1D1F]" size={20} strokeWidth={1.5} />
                  <h3 className="text-lg font-semibold tracking-tight">Cấu hình API Key</h3>
                </div>
                <button onClick={() => setShowSettings(false)} className="p-2 hover:bg-white/60 rounded-full transition-all active:scale-[0.97]">
                  <X size={20} strokeWidth={1.5} />
                </button>
              </div>
              <div className="p-5 sm:p-8 space-y-6 overflow-y-auto">
                <div className="space-y-4">
                  {serverKey && !manualKey && (
                    <div className="p-4 bg-green-50 border border-green-100 rounded-2xl flex items-start gap-3">
                      <CheckCircle2 className="text-green-600 mt-0.5" size={20} />
                      <div className="space-y-1">
                        <p className="text-sm font-bold text-green-800">Hệ thống đã kết nối</p>
                        <p className="text-xs text-green-700 leading-relaxed">
                          Ứng dụng đang sử dụng API Key mặc định của hệ thống. Bạn có thể nhập Key của riêng mình bên dưới nếu muốn.
                        </p>
                      </div>
                    </div>
                  )}
                  
                  {!serverKey && !manualKey && (
                    <div className="p-4 bg-blue-50 border border-blue-100 rounded-2xl">
                      <p className="text-sm text-blue-800 leading-relaxed">
                        Vui lòng nhập Gemini API Key của bạn để sử dụng ứng dụng. Key này sẽ được lưu an toàn trên trình duyệt của bạn (localStorage).
                      </p>
                    </div>
                  )}

                  {window.aistudio && !serverKey && (
                    <button
                      onClick={async () => {
                        try {
                          await window.aistudio!.openSelectKey();
                          setShowSettings(false);
                          setError(null);
                        } catch (e) {
                          console.error("Key selection error:", e);
                        }
                      }}
                      className="flex items-center justify-center gap-2 w-full py-3 bg-white/50 border border-white/60 text-[#1D1D1F] rounded-[24px] font-semibold hover:bg-white/80 transition-all shadow-sm active:scale-[0.97] mb-4 backdrop-blur-md"
                    >
                      <RefreshCw size={18} strokeWidth={1.5} />
                      Chọn API Key từ AI Studio
                    </button>
                  )}

                  <div className="space-y-2">
                    <label className="text-xs font-semibold uppercase tracking-wider text-[#666] ml-1">
                      Gemini API Key tùy chỉnh
                    </label>
                    <input
                      type="password"
                      value={manualKey}
                      onChange={(e) => {
                        setManualKey(e.target.value);
                      }}
                      placeholder="Dán API Key tại đây..."
                      className="w-full px-5 py-4 bg-white/50 border border-white/60 rounded-[24px] focus:ring-2 focus:ring-indigo-500/50 outline-none transition-all backdrop-blur-md shadow-inner"
                    />
                  </div>
                  <button
                    onClick={() => {
                      if (manualKey.trim()) {
                        localStorage.setItem('manquy_api_key', manualKey.trim());
                        setShowSettings(false);
                        setError(null);
                      } else {
                        localStorage.removeItem('manquy_api_key');
                        setShowSettings(false);
                      }
                    }}
                    className="w-full py-4 bg-gradient-primary text-white rounded-full font-semibold transition-all shadow-[0_8px_16px_rgba(99,102,241,0.2)] active:scale-[0.97]"
                  >
                    Lưu và Đóng
                  </button>
                  <a 
                    href="https://aistudio.google.com/app/apikey" 
                    target="_blank" 
                    rel="noreferrer"
                    className="text-xs text-blue-600 hover:underline block text-center mt-2"
                  >
                    Chưa có Key? Lấy miễn phí tại Google AI Studio
                  </a>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* History Drawer */}
      <AnimatePresence>
        {showHistory && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowHistory(false)}
              className="fixed inset-0 bg-black/40 backdrop-blur-sm z-30"
            />
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              className="fixed top-0 right-0 bottom-0 w-full max-w-md glass-panel z-40 border-l border-white/40 flex flex-col"
            >
              <div className="p-6 border-b border-white/40 flex items-center justify-between bg-white/40 backdrop-blur-md">
                <h3 className="text-xl font-semibold tracking-tight">Lịch sử phân tích</h3>
                <button onClick={() => setShowHistory(false)} className="p-2 hover:bg-white/60 rounded-full transition-all active:scale-[0.97]">
                  <X size={24} strokeWidth={1.5} />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-6 space-y-4">
                {history.length === 0 ? (
                  <div className="text-center py-12 text-[#999]">
                    <History size={48} strokeWidth={1.5} className="mx-auto mb-4 opacity-20" />
                    <p>Chưa có lịch sử nào</p>
                  </div>
                ) : (
                  history.map((item) => (
                    <div
                      key={item.id}
                      onClick={() => selectHistoryItem(item)}
                      className="group relative bg-white/50 border border-white/60 rounded-[24px] p-4 cursor-pointer hover:bg-white/80 transition-all hover:shadow-md backdrop-blur-md active:scale-[0.97]"
                    >
                      <div className="flex gap-4">
                        <div className="relative">
                          <img
                            src={item.images?.[0] || item.image}
                            alt="Thumbnail"
                            className="w-20 h-20 object-cover rounded-[16px] border border-white/60 shadow-sm"
                          />
                          {item.images && item.images.length > 1 && (
                            <div className="absolute -bottom-1 -right-1 bg-gradient-primary text-white text-[10px] font-bold px-1.5 py-0.5 rounded-md shadow-sm">
                              +{item.images.length - 1}
                            </div>
                          )}
                        </div>
                        <div className="flex-1 min-w-0 flex items-center">
                          <p className="text-sm font-medium text-[#333]">
                            {new Date(item.timestamp).toLocaleString('vi-VN')}
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={(e) => deleteHistoryItem(item.id, e)}
                        className="absolute top-2 right-2 p-2 text-red-400 sm:opacity-0 sm:group-hover:opacity-100 hover:text-red-600 transition-all active:scale-[0.97]"
                      >
                        <Trash2 size={16} strokeWidth={1.5} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Footer */}
      <footer className="max-w-4xl mx-auto px-6 py-12 text-center text-[#999] text-sm">
        <p>© 2026 Mận Quý • Powered by Gemini AI</p>
      </footer>
    </div>
  );
}
