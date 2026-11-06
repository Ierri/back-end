export interface ApiSuccess<T> {
  success: true;
  message: string;
  data: T;
}

export interface ApiErrorDetail {
  field: string;
  message: string;
}

export interface ApiFailure {
  success: false;
  error: {
    code: string;
    message: string;
    details: ApiErrorDetail[];
  };
}
